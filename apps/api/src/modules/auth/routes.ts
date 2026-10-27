import { LoginInputSchema, RegisterInputSchema, type AuthResponse } from "@guardian/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context";
import { parseWith, unauthorized } from "../../lib/errors";
import { metaOf, requireAuth, userIdOf } from "../../plugins/auth";
import * as auth from "./service";

export const REFRESH_COOKIE = "guardian_rt";

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const cookiePath = "/api/v1/auth";
  // Credential endpoints get a tight per-IP limit to slow brute force and signup abuse.
  const authRateLimit = { config: { rateLimit: { max: ctx.config.rateLimits.authPerMinute, timeWindow: "1 minute" } } };

  const sendSession = (reply: FastifyReply, session: auth.Session, status = 200): AuthResponse => {
    // The refresh token lives only in an httpOnly cookie scoped to the auth routes.
    reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: ctx.config.isProduction,
      sameSite: "lax",
      path: cookiePath,
      expires: session.refreshExpiresAt,
    });
    reply.status(status);
    return { accessToken: session.accessToken, expiresIn: session.expiresIn, user: session.user };
  };

  const refreshTokenFrom = (cookies: Record<string, string | undefined>, body: unknown): string | undefined =>
    cookies[REFRESH_COOKIE] ?? z.object({ refreshToken: z.string().min(1) }).safeParse(body).data?.refreshToken;

  app.post("/auth/register", authRateLimit, async (req, reply) => {
    const input = parseWith(RegisterInputSchema, req.body);
    return sendSession(reply, await auth.register(ctx, input, metaOf(req)), 201);
  });

  app.post("/auth/login", authRateLimit, async (req, reply) => {
    const input = parseWith(LoginInputSchema, req.body);
    return sendSession(reply, await auth.login(ctx, input, metaOf(req)));
  });

  app.post("/auth/refresh", authRateLimit, async (req, reply) => {
    const token = refreshTokenFrom(req.cookies, req.body);
    if (!token) throw unauthorized("No session");
    try {
      return sendSession(reply, await auth.refresh(ctx, token, metaOf(req)));
    } catch (error) {
      reply.clearCookie(REFRESH_COOKIE, { path: cookiePath });
      throw error;
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    await auth.logout(ctx, refreshTokenFrom(req.cookies, req.body), metaOf(req));
    reply.clearCookie(REFRESH_COOKIE, { path: cookiePath });
    return reply.status(204).send();
  });

  app.get("/auth/me", { preHandler: requireAuth(ctx) }, async (req) => auth.getMe(ctx, userIdOf(req)));
}

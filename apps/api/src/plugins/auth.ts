import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import type { RequestMeta } from "../lib/audit";
import { unauthorized } from "../lib/errors";
import { verifyAccessToken } from "../lib/security";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

/** preHandler that requires a valid Bearer access token and sets `request.userId`. */
export function requireAuth(ctx: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    try {
      const { userId } = await verifyAccessToken(header.slice(7), ctx.config.auth.jwtSecret);
      request.userId = userId;
    } catch {
      throw unauthorized("Access token is invalid or expired");
    }
  };
}

export function userIdOf(request: FastifyRequest): string {
  if (!request.userId) throw unauthorized();
  return request.userId;
}

export function metaOf(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers["user-agent"] ?? null };
}

import type { AuthResponse, LoginInput, RegisterInput, UserDto } from "@guardian/shared";
import type { AppContext } from "../../context";
import { isUniqueViolation, type Queryable } from "../../db/index";
import { recordAudit, type RequestMeta } from "../../lib/audit";
import { AppError, conflict, notFound, unauthorized } from "../../lib/errors";
import { toUserDto, type UserRow } from "../../lib/mappers";
import {
  generateRefreshToken,
  getDummyPasswordHash,
  hashPassword,
  hashToken,
  signAccessToken,
  verifyPassword,
} from "../../lib/security";

export type Session = AuthResponse & { refreshToken: string; refreshExpiresAt: Date };

export async function register(ctx: AppContext, input: RegisterInput, meta: RequestMeta): Promise<Session> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<UserRow>(
        `INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING *`,
        [input.email, passwordHash, input.fullName ?? null],
      );
      const user = rows[0]!;
      await tx.query(`INSERT INTO user_policies (user_id) VALUES ($1)`, [user.id]);
      await recordAudit(tx, { userId: user.id, actor: "user", action: "auth.registered", outcome: "success", meta });
      return issueSession(ctx, tx, user, meta);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("EMAIL_TAKEN", "An account with this email already exists");
    throw error;
  }
}

export async function login(ctx: AppContext, input: LoginInput, meta: RequestMeta): Promise<Session> {
  const { rows } = await ctx.db.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [input.email]);
  const user = rows[0];
  // Always run a hash comparison so response time doesn't reveal whether the email exists.
  const valid = await verifyPassword(input.password, user?.password_hash ?? (await getDummyPasswordHash()));
  if (!user || !valid) {
    if (user) await recordAudit(ctx.db, { userId: user.id, actor: "user", action: "auth.login", outcome: "invalid_password", meta });
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  if (user.status !== "active") throw new AppError(403, "ACCOUNT_DISABLED", "This account is disabled");
  return ctx.db.transaction(async (tx) => {
    await recordAudit(tx, { userId: user.id, actor: "user", action: "auth.login", outcome: "success", meta });
    return issueSession(ctx, tx, user, meta);
  });
}

/**
 * Rotates a refresh token. Presenting an already-rotated token is treated as theft:
 * every session for that user is revoked.
 */
export async function refresh(ctx: AppContext, rawToken: string, meta: RequestMeta): Promise<Session> {
  const hash = hashToken(rawToken);
  const outcome = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null }>(
      `SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hash],
    );
    const token = rows[0];
    if (!token) return { kind: "invalid" as const };
    if (token.revoked_at) {
      await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [token.user_id]);
      await recordAudit(tx, { userId: token.user_id, actor: "system", action: "auth.refresh_token_reuse", outcome: "all_sessions_revoked", meta });
      return { kind: "reused" as const };
    }
    if (new Date(token.expires_at) <= new Date()) return { kind: "invalid" as const };

    const { rows: users } = await tx.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [token.user_id]);
    const user = users[0];
    if (!user) return { kind: "invalid" as const };
    const session = await issueSession(ctx, tx, user, meta);
    await tx.query(
      `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = (SELECT id FROM refresh_tokens WHERE token_hash = $2) WHERE id = $1`,
      [token.id, hashToken(session.refreshToken)],
    );
    return { kind: "ok" as const, session };
  });
  // Thrown outside the transaction so the reuse revocation above is committed, not rolled back.
  if (outcome.kind !== "ok") throw unauthorized(outcome.kind === "reused" ? "Session was revoked" : "Invalid or expired session");
  return outcome.session;
}

export async function logout(ctx: AppContext, rawToken: string | undefined, meta: RequestMeta): Promise<void> {
  if (!rawToken) return;
  const { rows } = await ctx.db.query<{ user_id: string }>(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id`,
    [hashToken(rawToken)],
  );
  if (rows[0]) await recordAudit(ctx.db, { userId: rows[0].user_id, actor: "user", action: "auth.logout", outcome: "success", meta });
}

export async function getMe(ctx: AppContext, userId: string): Promise<UserDto> {
  const { rows } = await ctx.db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) throw notFound("User");
  return toUserDto(rows[0]);
}

async function issueSession(ctx: AppContext, q: Queryable, user: UserRow, meta: RequestMeta): Promise<Session> {
  const { jwtSecret, accessTokenTtlSeconds, refreshTokenTtlDays } = ctx.config.auth;
  const accessToken = await signAccessToken(user.id, jwtSecret, accessTokenTtlSeconds);
  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + refreshTokenTtlDays * 86_400_000);
  await q.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4)`, [
    user.id,
    refreshToken.hash,
    refreshExpiresAt,
    meta.userAgent?.slice(0, 512) ?? null,
  ]);
  return { accessToken, expiresIn: accessTokenTtlSeconds, user: toUserDto(user), refreshToken: refreshToken.token, refreshExpiresAt };
}

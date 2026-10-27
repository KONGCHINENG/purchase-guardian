import webpush from "web-push";
import { z } from "zod";
import type { Config } from "../../config";
import type { AppContext } from "../../context";
import type { Database } from "../../db/index";

export type PushMessage = { title: string; body: string; url: string; tag?: string };

/** Sends a notification to every device a user has installed the app on. */
export interface Notifier {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  notifyUser(userId: string, message: PushMessage): Promise<void>;
}

export class NoopNotifier implements Notifier {
  readonly enabled = false;
  readonly publicKey = null;
  async notifyUser(): Promise<void> {}
}

export class WebPushNotifier implements Notifier {
  readonly enabled = true;
  readonly publicKey: string;

  constructor(
    private readonly db: Database,
    vapid: NonNullable<Config["push"]>,
  ) {
    this.publicKey = vapid.publicKey;
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async notifyUser(userId: string, message: PushMessage): Promise<void> {
    const { rows } = await this.db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
      [userId],
    );
    await Promise.all(
      rows.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(message),
            { TTL: 60 * 30, urgency: "high" },
          );
        } catch (error) {
          // 404/410: the browser dropped this subscription; stop sending to it.
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await this.db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
          else throw error;
        }
      }),
    );
  }
}

export function createNotifier(db: Database, config: Config["push"]): Notifier {
  return config ? new WebPushNotifier(db, config) : new NoopNotifier();
}

export const SubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export async function saveSubscription(ctx: AppContext, userId: string, sub: z.infer<typeof SubscriptionSchema>, userAgent: string | null) {
  // Re-subscribing from the same browser moves the endpoint to the current user.
  await ctx.db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 512) ?? null],
  );
}

export async function deleteSubscription(ctx: AppContext, userId: string, endpoint: string) {
  await ctx.db.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
}

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as webpush from 'web-push';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where clicking the notification takes the player. */
  url?: string;
  icon?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

/**
 * Web Push delivery.
 *
 * This is the one channel that reaches a player with the site CLOSED — the
 * WebSocket gateway only reaches an open tab. The two are complementary and
 * both are driven from the same notification record.
 *
 * Payloads are encrypted end-to-end by the web-push library using the
 * subscription's own p256dh/auth keys, so Google/Mozilla/Apple relay ciphertext
 * they cannot read. The VAPID private key proves to those services that the
 * sender is us, so it must never leave the server.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly configured: boolean;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    // A mailto/URL subject is required by the spec so a push service can
    // contact the sender about abuse.
    const subject = process.env.VAPID_SUBJECT || 'mailto:support@winx-88.com';

    this.configured = Boolean(publicKey && privateKey);
    if (this.configured) {
      webpush.setVapidDetails(subject, publicKey!, privateKey!);
    } else {
      // Deliberately not fatal: the rest of the notification system (in-app +
      // socket) must keep working on an environment without VAPID keys.
      this.logger.warn(
        'VAPID keys not set — web push is disabled. In-app and socket notifications are unaffected.',
      );
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  /** The public key the browser needs to create a subscription. */
  getPublicKey(): string | null {
    return this.configured ? process.env.VAPID_PUBLIC_KEY! : null;
  }

  /**
   * Store (or refresh) a browser's subscription.
   *
   * Keyed on `endpoint`, so the same browser re-subscribing updates its row
   * instead of creating a duplicate — otherwise the player would receive every
   * notification once per stale row.
   */
  async subscribe(userId: number, sub: PushSubscriptionInput, userAgent?: string) {
    const endpoint = sub?.endpoint?.trim();
    const p256dh = sub?.keys?.p256dh?.trim();
    const auth = sub?.keys?.auth?.trim();

    if (!endpoint || !p256dh || !auth) {
      throw new BadRequestException('endpoint and keys.p256dh / keys.auth are required');
    }
    if (!/^https:\/\//i.test(endpoint)) {
      throw new BadRequestException('endpoint must be an https URL');
    }

    await this.dataSource.query(
      `INSERT INTO public.push_subscriptions
         (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id       = EXCLUDED.user_id,
         p256dh        = EXCLUDED.p256dh,
         auth          = EXCLUDED.auth,
         user_agent    = COALESCE(EXCLUDED.user_agent, push_subscriptions.user_agent),
         is_active     = TRUE,
         failure_count = 0,
         updated_at    = NOW()`,
      [userId, endpoint, p256dh, auth, (userAgent ?? '').slice(0, 400) || null],
    );

    return { subscribed: true };
  }

  async unsubscribe(userId: number, endpoint: string) {
    if (!endpoint) throw new BadRequestException('endpoint is required');
    // Scoped to the user so one player cannot remove another's subscription.
    const result = await this.dataSource.query(
      `DELETE FROM public.push_subscriptions
        WHERE endpoint = $1 AND user_id = $2
        RETURNING id`,
      [endpoint, userId],
    );
    const rows = Array.isArray(result?.[0]) ? result[0] : result;
    return { unsubscribed: (rows?.length ?? 0) > 0 };
  }

  /** How many live browsers this player has registered. */
  async countForUser(userId: number): Promise<number> {
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM public.push_subscriptions
        WHERE user_id = $1 AND is_active`,
      [userId],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Push to every live browser for a user.
   *
   * Never throws: a notification must still be stored and socket-delivered even
   * if a push service is down. Returns a per-device summary for logging.
   */
  async sendToUser(userId: number, payload: PushPayload) {
    if (!this.configured) return { sent: 0, failed: 0, pruned: 0, skipped: 'NOT_CONFIGURED' };

    const subs = await this.dataSource.query(
      `SELECT id, endpoint, p256dh, auth FROM public.push_subscriptions
        WHERE user_id = $1 AND is_active`,
      [userId],
    );
    if (!subs.length) return { sent: 0, failed: 0, pruned: 0 };

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ?? '/',
      icon: payload.icon ?? '/shortcuts/promotions.png',
      // `tag` lets a newer notification replace an older one of the same kind
      // instead of stacking five identical banners.
      tag: payload.tag,
      data: payload.data ?? {},
    });

    let sent = 0;
    let failed = 0;
    let pruned = 0;

    await Promise.all(
      subs.map(async (s: any) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
          );
          sent++;
          await this.dataSource.query(
            `UPDATE public.push_subscriptions
                SET last_sent_at = NOW(), failure_count = 0 WHERE id = $1`,
            [s.id],
          );
        } catch (err: any) {
          const status = err?.statusCode;
          // 404/410 mean the subscription is permanently gone (browser data
          // cleared, permission revoked). Keeping it would retry forever.
          if (status === 404 || status === 410) {
            await this.dataSource.query(
              `DELETE FROM public.push_subscriptions WHERE id = $1`,
              [s.id],
            );
            pruned++;
            return;
          }
          failed++;
          await this.dataSource.query(
            `UPDATE public.push_subscriptions
                SET failure_count = failure_count + 1,
                    last_failed_at = NOW(),
                    -- Retire an endpoint that keeps failing, but only after
                    -- repeated attempts so one outage doesn't drop everyone.
                    is_active = (failure_count + 1) < 10
              WHERE id = $1`,
            [s.id],
          );
          this.logger.warn(
            `Push to subscription ${s.id} failed (status ${status ?? 'n/a'})`,
          );
        }
      }),
    );

    return { sent, failed, pruned };
  }
}

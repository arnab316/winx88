import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, QueryRunner } from 'typeorm';
import { MetaCapiClient, CapiEvent } from './meta-capi.client';

/**
 * Outbox for Meta Conversions API events.
 *
 * ENQUEUE happens inside the caller's transaction — the deposit approval, or
 * the post-commit signup hook. That is the whole point: a conversion cannot
 * exist for a deposit that rolled back, and cannot be lost for one that
 * committed. Meta is never called inline; a slow HTTP round trip would hold
 * the wallet row lock open.
 *
 * DELIVERY is a once-a-minute sweeper with exponential backoff, modelled on
 * DepositExpiryService. Rows are claimed with FOR UPDATE SKIP LOCKED so two
 * app instances never send the same event twice.
 */

const MAX_ATTEMPTS = 5;
/** Backoff per attempt number (1-indexed). Meta rejects events older than 7d. */
const BACKOFF_MINUTES = [1, 5, 25, 120, 600];
const BATCH_SIZE = 25;

@Injectable()
export class MetaCapiService {
  private readonly logger = new Logger(MetaCapiService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly client: MetaCapiClient,
  ) {}

  // ═════════════════════════════════════════════════════════════
  // ENQUEUE
  // ═════════════════════════════════════════════════════════════

  /**
   * Queue a conversion, inside the caller's transaction.
   *
   * Resolves the player's campaign and its bound pixel; returns silently when
   * the player has no channel or the channel has no pixel — most players are
   * organic and must not generate rows.
   *
   * NEVER throws. A tracking problem must not roll back a deposit approval.
   *
   * @param qr the caller's QueryRunner, so the row shares its transaction
   */
  async enqueue(
    qr: QueryRunner,
    ev: {
      eventName: 'Purchase' | 'CompleteRegistration';
      eventId: string;
      userId: number;
      depositId?: number | null;
      value?: number | null;
      currency?: string;
      isFtd?: boolean;
    },
  ): Promise<void> {
    try {
      // Channel + pixel for this player. LEFT JOIN so a player attributed to a
      // channel that was since deleted still resolves to "no pixel" quietly.
      const rows = await qr.query(
        `SELECT a.channel_id, mc.pixel_id
           FROM user_channel_attribution a
           LEFT JOIN marketing_channels mc ON mc.id = a.channel_id
          WHERE a.user_id = $1
          LIMIT 1`,
        [ev.userId],
      );
      const pixelId: string | null = rows[0]?.pixel_id ?? null;
      if (!pixelId) return; // organic, or campaign has no pixel bound

      await qr.query(
        `INSERT INTO meta_capi_events
           (event_name, event_id, user_id, deposit_id, channel_id, pixel_id,
            value, currency, is_ftd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          ev.eventName,
          ev.eventId,
          ev.userId,
          ev.depositId ?? null,
          rows[0]?.channel_id ?? null,
          pixelId,
          ev.value ?? null,
          ev.currency ?? 'BDT',
          ev.isFtd ?? false,
        ],
      );
    } catch (e: any) {
      this.logger.warn(
        `enqueue failed (${ev.eventName}, user=${ev.userId}): ${e?.message}`,
      );
    }
  }

  /**
   * Deterministic dedup key, shared with the browser pixel so Meta merges the
   * two rather than counting one conversion twice. Must be reproducible from
   * data the frontend also has.
   */
  static eventIdFor(kind: 'dep' | 'reg', id: number | string): string {
    return `${kind}_${id}`;
  }

  // ═════════════════════════════════════════════════════════════
  // DELIVERY
  // ═════════════════════════════════════════════════════════════

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    if (!this.client.enabled) return; // ships disabled; outbox still fills

    try {
      // Claim a batch atomically. SKIP LOCKED means a second instance takes a
      // different batch rather than blocking or double-sending.
      const claimed = await this.dataSource.query(
        `UPDATE meta_capi_events
            SET attempts = attempts + 1
          WHERE id IN (
            SELECT id FROM meta_capi_events
             WHERE status = 'PENDING' AND next_attempt_at <= NOW()
             ORDER BY next_attempt_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, event_name, event_id, event_time, user_id, deposit_id,
                    channel_id, pixel_id, value, currency, is_ftd, attempts`,
        [BATCH_SIZE],
      );
      // UPDATE ... RETURNING comes back as [rows, count] in TypeORM.
      const rows = Array.isArray(claimed?.[0]) ? claimed[0] : claimed;
      if (!rows?.length) return;

      for (const row of rows) {
        await this.deliver(row);
      }
    } catch (e: any) {
      this.logger.error(`CAPI sweep failed: ${e?.message}`);
    }
  }

  private async deliver(row: any): Promise<void> {
    try {
      // Identity for matching. The click row carries fbc/fbp/ip/user-agent —
      // without them Meta often cannot tie the conversion to the ad at all.
      const [ident] = await this.dataSource.query(
        `SELECT u.email, u.id AS uid,
                (SELECT p.phone_number FROM user_phone_numbers p
                  WHERE p.user_id = u.id AND p.is_primary = true LIMIT 1) AS phone,
                k.fbc, k.fbp, k.ip, k.user_agent,
                mc.capi_access_token
           FROM users u
           LEFT JOIN user_channel_attribution a ON a.user_id = u.id
           LEFT JOIN marketing_clicks k         ON k.id = a.click_id
           LEFT JOIN marketing_channels mc      ON mc.id = a.channel_id
          WHERE u.id = $1
          LIMIT 1`,
        [row.user_id],
      );

      const event: CapiEvent = {
        pixelId: row.pixel_id,
        accessToken: ident?.capi_access_token ?? null,
        eventName: row.event_name,
        eventId: row.event_id,
        eventTime: new Date(row.event_time),
        value: row.value != null ? Number(row.value) : null,
        currency: row.currency ?? 'BDT',
        userData: {
          email: ident?.email ?? null,
          phone: ident?.phone ?? null,
          externalId: ident?.uid ?? row.user_id,
          clientIp: ident?.ip ?? null,
          userAgent: ident?.user_agent ?? null,
          fbc: ident?.fbc ?? null,
          fbp: ident?.fbp ?? null,
        },
        customData: row.is_ftd ? { is_ftd: true } : undefined,
      };

      const payload = this.client.buildPayload(event);
      const result = await this.client.send(event);

      if (result.ok) {
        await this.dataSource.query(
          `UPDATE meta_capi_events
              SET status = 'SENT', sent_at = NOW(), last_error = NULL, payload = $2
            WHERE id = $1`,
          [row.id, JSON.stringify(payload)],
        );
        return;
      }

      // Give up on a permanent rejection (bad token, no pixel access) or once
      // attempts are exhausted — retrying a malformed request forever just
      // hides the problem.
      const attempts = Number(row.attempts);
      const giveUp = !result.retryable || attempts >= MAX_ATTEMPTS;
      const backoff = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] ?? 600;

      await this.dataSource.query(
        `UPDATE meta_capi_events
            SET status = $2,
                last_error = $3,
                payload = $4,
                next_attempt_at = NOW() + ($5 || ' minutes')::interval
          WHERE id = $1`,
        [
          row.id,
          giveUp ? 'FAILED' : 'PENDING',
          result.error,
          JSON.stringify(payload),
          String(backoff),
        ],
      );

      if (giveUp) {
        this.logger.error(
          `CAPI event ${row.event_id} gave up after ${attempts} attempt(s): ${result.error}`,
        );
      }
    } catch (e: any) {
      // Deliver must never throw — the sweep has to continue to the next row.
      this.logger.error(`CAPI deliver error for event ${row?.event_id}: ${e?.message}`);
      await this.dataSource
        .query(
          `UPDATE meta_capi_events
              SET last_error = $2, next_attempt_at = NOW() + INTERVAL '5 minutes'
            WHERE id = $1`,
          [row.id, String(e?.message ?? 'unknown').slice(0, 500)],
        )
        .catch(() => undefined);
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN VIEW
  // ═════════════════════════════════════════════════════════════

  /** Outbox health — answers "why has Facebook stopped receiving conversions". */
  async listEvents(q: { status?: string; page?: number; limit?: number }) {
    const page = Math.max(Number(q.page) || 1, 1);
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const status = q.status?.toUpperCase() ?? null;

    const rows = await this.dataSource.query(
      `SELECT e.id, e.event_name, e.event_id, e.status, e.attempts, e.last_error,
              e.pixel_id, e.value, e.currency, e.is_ftd, e.user_id, e.deposit_id,
              e.next_attempt_at, e.sent_at, e.created_at,
              mc.code AS channel_code, u.username
         FROM meta_capi_events e
         LEFT JOIN marketing_channels mc ON mc.id = e.channel_id
         LEFT JOIN users u               ON u.id = e.user_id
        WHERE ($1::text IS NULL OR e.status = $1::text)
        ORDER BY e.created_at DESC
        LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );

    const [counts] = await this.dataSource.query(
      `SELECT COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE status='SENT')::int    AS sent,
              COUNT(*) FILTER (WHERE status='FAILED')::int  AS failed
         FROM meta_capi_events`,
    );

    return {
      success: true,
      enabled: this.client.enabled,
      summary: counts,
      data: rows,
      page,
      limit,
    };
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WEB PUSH SUBSCRIPTIONS — browser push that reaches a player with the site
 * closed, which the WebSocket gateway cannot do.
 *
 * One row per BROWSER, not per user: a player may allow notifications on their
 * phone and their desktop, and each gets its own endpoint from the browser's
 * push service. `endpoint` is therefore the natural key and is UNIQUE — the
 * same browser re-subscribing must update its row, never create a second one,
 * or the player receives every notification twice.
 *
 * `p256dh` and `auth` are the client's encryption keys. Web Push payloads are
 * encrypted end-to-end so the push service (Google/Mozilla/Apple) relays
 * ciphertext it cannot read. They are useless without the server's VAPID
 * private key, but they are still per-user secrets and must never be returned
 * to any client.
 *
 * `failure_count` / `last_failed_at` support pruning: a push service answers
 * 404/410 once a subscription is permanently dead (browser data cleared, app
 * uninstalled). Those are deleted immediately; transient errors are counted so
 * a persistently failing endpoint can be retired without discarding a good
 * subscription after one network blip.
 *
 * Idempotent.
 */
export class PushSubscriptions2240000000000 implements MigrationInterface {
  name = 'PushSubscriptions2240000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.push_subscriptions (
        id             BIGSERIAL    PRIMARY KEY,
        user_id        BIGINT       NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        endpoint       TEXT         NOT NULL,
        p256dh         TEXT         NOT NULL,
        auth           TEXT         NOT NULL,
        user_agent     VARCHAR(400),
        is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
        failure_count  INTEGER      NOT NULL DEFAULT 0,
        last_failed_at TIMESTAMPTZ,
        last_sent_at   TIMESTAMPTZ,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // The browser's endpoint identifies the device; re-subscribing updates it.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_push_subscriptions_endpoint
        ON public.push_subscriptions (endpoint);
    `);

    // Sending reads "every live subscription for this user".
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
        ON public.push_subscriptions (user_id) WHERE is_active;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_push_subscriptions_user;`);
    await q.query(`DROP INDEX IF EXISTS public.uq_push_subscriptions_endpoint;`);
    await q.query(`DROP TABLE IF EXISTS public.push_subscriptions;`);
  }
}

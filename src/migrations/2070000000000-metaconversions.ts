import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * META PIXEL BINDING + CONVERSIONS API.
 *
 * The channel tracking added in 2050000000000 tells US and the media buyer how
 * each campaign performed. It tells FACEBOOK nothing — so Facebook's algorithm
 * cannot learn which creative produces depositors, and cannot shift budget
 * toward it. That is what the buyer meant by "the effect of Fb data placement
 * cannot be optimized in real time".
 *
 * Two halves:
 *
 *  1. PIXEL BINDING. Each campaign carries the buyer's own pixel id, so their
 *     ad account receives the conversions it needs to optimise. Ours keeps
 *     firing alongside it — dropping ours would hand the audience data and the
 *     algorithmic learning, paid for with our traffic, entirely to them.
 *
 *  2. SERVER-SIDE CONVERSIONS. Deposits here are approved by an admin, often
 *     hours after the player has closed the browser. A pixel physically cannot
 *     fire at that moment, so the event that actually matters — money arriving
 *     — is invisible to Facebook unless we send it from the backend.
 *
 * `meta_capi_events` is an OUTBOX, not a log. The row is written inside the
 * same transaction that approves the deposit, so a conversion can never exist
 * for a deposit that rolled back, nor be lost for one that committed. A cron
 * sweeper then delivers it with retries. Calling Meta inline would hold the
 * wallet row lock open across an HTTP round trip.
 *
 * `event_id` is the deduplication key: the browser pixel sends the same value,
 * so Meta merges the two rather than counting the conversion twice.
 *
 * fbclid / fbc / fbp drive MATCH QUALITY. Without them Meta frequently cannot
 * tie the conversion back to the ad at all, which defeats the exercise.
 *
 * Idempotent.
 */
export class MetaConversions2070000000000 implements MigrationInterface {
  name = 'MetaConversions2070000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── Per-campaign pixel binding ──
    // capi_access_token is optional: a buyer running ads from their own Business
    // Manager needs their own token, otherwise the platform-wide one is used.
    await q.query(`
      ALTER TABLE public.marketing_channels
        ADD COLUMN IF NOT EXISTS pixel_id          VARCHAR(32),
        ADD COLUMN IF NOT EXISTS capi_access_token TEXT;
    `);

    // ── Ad-platform click identifiers, captured at the redirect ──
    // fbc is the cookie-format derivation of fbclid (fb.1.<unix_ms>.<fbclid>);
    // storing it saves recomputing a timestamp we would no longer know.
    await q.query(`
      ALTER TABLE public.marketing_clicks
        ADD COLUMN IF NOT EXISTS fbclid VARCHAR(255),
        ADD COLUMN IF NOT EXISTS fbc    VARCHAR(128),
        ADD COLUMN IF NOT EXISTS fbp    VARCHAR(64);
    `);

    // ── The outbox ──
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.meta_capi_events (
        id              BIGSERIAL PRIMARY KEY,
        event_name      VARCHAR(40) NOT NULL,
        event_id        VARCHAR(64) NOT NULL UNIQUE,
        event_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_id         BIGINT,
        deposit_id      BIGINT,
        channel_id      BIGINT REFERENCES public.marketing_channels(id) ON DELETE SET NULL,
        pixel_id        VARCHAR(32) NOT NULL,
        value           NUMERIC(18,2),
        currency        VARCHAR(8) NOT NULL DEFAULT 'BDT',
        is_ftd          BOOLEAN NOT NULL DEFAULT false,
        payload         JSONB,
        status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
        attempts        INT NOT NULL DEFAULT 0,
        last_error      TEXT,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Drives the once-a-minute sweep. Partial, so it only covers the handful of
    // undelivered rows rather than the whole history — same shape as
    // idx_deposits_pending_requested.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_capi_pending_next
        ON public.meta_capi_events (next_attempt_at)
        WHERE status = 'PENDING';
    `);

    // For the admin health screen ("why has Facebook stopped receiving these").
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_capi_status_created
        ON public.meta_capi_events (status, created_at DESC);
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_capi_user
        ON public.meta_capi_events (user_id);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS public.meta_capi_events;`);
    await q.query(`
      ALTER TABLE public.marketing_clicks
        DROP COLUMN IF EXISTS fbp,
        DROP COLUMN IF EXISTS fbc,
        DROP COLUMN IF EXISTS fbclid;
    `);
    await q.query(`
      ALTER TABLE public.marketing_channels
        DROP COLUMN IF EXISTS capi_access_token,
        DROP COLUMN IF EXISTS pixel_id;
    `);
  }
}

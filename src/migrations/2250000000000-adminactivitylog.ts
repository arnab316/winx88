import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * admin_activity_logs — the "Track" audit trail.
 *
 * One row per admin write request (POST / PUT / PATCH / DELETE), recorded by
 * the global AdminActivityInterceptor, so every admin action is captured —
 * including routes added after this migration — without instrumenting each
 * endpoint by hand.
 *
 *   admin_id          admin_users.id — intentionally NO FK (admins live in a
 *                     separate table and may be deleted; the log must survive)
 *   target_user_ids   every player the action touched (a referral touches two,
 *                     a notification can touch many). GIN-indexed so a
 *                     player's Track tab is one indexed lookup.
 *   details           redacted request body, before/after field changes,
 *                     route params. Passwords / secrets / OTPs never stored.
 *
 * Idempotent.
 */
export class AdminActivityLog2250000000000 implements MigrationInterface {
  name = 'AdminActivityLog2250000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.admin_activity_logs (
        id               BIGSERIAL    PRIMARY KEY,
        admin_id         BIGINT,
        action           VARCHAR(80)  NOT NULL,
        summary          TEXT         NOT NULL,
        method           VARCHAR(8)   NOT NULL,
        path             TEXT         NOT NULL,
        target_user_ids  BIGINT[]     NOT NULL DEFAULT '{}',
        details          JSONB        NOT NULL DEFAULT '{}'::jsonb,
        success          BOOLEAN      NOT NULL DEFAULT TRUE,
        status_code      INTEGER,
        error            TEXT,
        ip               VARCHAR(64),
        user_agent       TEXT,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_activity_targets
        ON public.admin_activity_logs USING GIN (target_user_ids);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_activity_admin
        ON public.admin_activity_logs (admin_id, created_at DESC);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_activity_created
        ON public.admin_activity_logs (created_at DESC);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS public.admin_activity_logs;`);
  }
}

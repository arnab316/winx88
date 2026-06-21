import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Affiliate click tracking (winX88partners §5 `clicks`).
 *
 * Raw referral-link clicks, captured by the public /r/:code redirect before the
 * visitor ever registers. `referral_code` is always stored; `affiliate_user_id`
 * / `referrer_user_id` are resolved best-effort at capture time and may be NULL
 * for an unknown/stale code. Powers the "Sign-ups vs clicks" funnel and the
 * per-affiliate click KPI. Nothing else in the affiliate flow is altered.
 */
export class AffiliateClicks1880000000000 implements MigrationInterface {
  name = 'AffiliateClicks1880000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.affiliate_clicks (
        id                BIGSERIAL PRIMARY KEY,
        referral_code     VARCHAR(40) NOT NULL,
        affiliate_user_id BIGINT,            -- affiliate_users.id, NULL if code owner isn't an affiliate
        referrer_user_id  BIGINT,            -- users.id of the code owner, NULL if code unknown
        ip                VARCHAR(64),
        user_agent        TEXT,
        referer           TEXT,
        landing_path      VARCHAR(255),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT affiliate_clicks_affiliate_fk FOREIGN KEY (affiliate_user_id)
          REFERENCES public.affiliate_users(id) ON DELETE SET NULL
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_code      ON public.affiliate_clicks(referral_code);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_affiliate ON public.affiliate_clicks(affiliate_user_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_referrer  ON public.affiliate_clicks(referrer_user_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_created   ON public.affiliate_clicks(created_at);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.affiliate_clicks;`);
  }
}

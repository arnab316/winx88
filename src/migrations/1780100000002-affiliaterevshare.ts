import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Affiliate RevShare program (build-guide §7).
 *
 * The existing affiliate module is a per-referee commission system. This adds
 * the RevShare layer on top: a monthly NGR ledger, RevShare tier/rate +
 * payment details on affiliate_users, and a single-row config table holding
 * the admin-fee %, payout threshold, active-player minimum and the tier
 * ladder. Nothing in the existing referral flow is altered.
 */
export class AffiliateRevShare1780100000002 implements MigrationInterface {
  name = 'AffiliateRevShare1780100000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── affiliate_users: RevShare tier / rate / payout method ──
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users
        ADD COLUMN IF NOT EXISTS revshare_tier   SMALLINT,
        ADD COLUMN IF NOT EXISTS revshare_rate   NUMERIC(5,2),
        ADD COLUMN IF NOT EXISTS payment_method  VARCHAR(20),
        ADD COLUMN IF NOT EXISTS payment_details JSONB;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payment_method_check') THEN
          ALTER TABLE public.affiliate_users
            ADD CONSTRAINT affiliate_payment_method_check
            CHECK (payment_method IS NULL OR payment_method IN ('BANK','USDT','BKASH','NAGAD'));
        END IF;
      END $$;
    `);

    // ── affiliate_revshare_config: single-row tunables ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.affiliate_revshare_config (
        id                  SMALLINT PRIMARY KEY DEFAULT 1,
        admin_fee_pct       NUMERIC(5,2)  NOT NULL DEFAULT 18,
        min_threshold       NUMERIC(18,2) NOT NULL DEFAULT 5000,
        min_active_players  INTEGER       NOT NULL DEFAULT 5,
        tier1_max           INTEGER       NOT NULL DEFAULT 10,
        tier2_max           INTEGER       NOT NULL DEFAULT 30,
        tier3_max           INTEGER       NOT NULL DEFAULT 50,
        rate1               NUMERIC(5,2)  NOT NULL DEFAULT 25,
        rate2               NUMERIC(5,2)  NOT NULL DEFAULT 30,
        rate3               NUMERIC(5,2)  NOT NULL DEFAULT 35,
        rate4               NUMERIC(5,2)  NOT NULL DEFAULT 40,
        updated_by_admin_id BIGINT,
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT affiliate_revshare_config_singleton CHECK (id = 1)
      );
    `);
    await queryRunner.query(`
      INSERT INTO public.affiliate_revshare_config (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);

    // ── affiliate_monthly_ngr: one row per (affiliate, period) ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.affiliate_monthly_ngr (
        id                  BIGSERIAL PRIMARY KEY,
        affiliate_user_id   BIGINT       NOT NULL,
        period              CHAR(7)      NOT NULL,            -- 'YYYY-MM'
        total_bets          NUMERIC(18,2) NOT NULL DEFAULT 0,
        total_wins          NUMERIC(18,2) NOT NULL DEFAULT 0,
        bonuses_given       NUMERIC(18,2) NOT NULL DEFAULT 0,
        admin_fee           NUMERIC(18,2) NOT NULL DEFAULT 0,
        ngr                 NUMERIC(18,2) NOT NULL DEFAULT 0,
        active_player_count INTEGER       NOT NULL DEFAULT 0,
        revshare_rate       NUMERIC(5,2)  NOT NULL DEFAULT 0,
        gross_earning       NUMERIC(18,2) NOT NULL DEFAULT 0, -- rate × NGR after NNCO
        carried_in          NUMERIC(18,2) NOT NULL DEFAULT 0, -- rolled in from prior month
        carried_forward     NUMERIC(18,2) NOT NULL DEFAULT 0, -- rolled to next month
        payable_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
        status              VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
        txn_ref             VARCHAR(120),
        paid_at             TIMESTAMPTZ,
        computed_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT amn_affiliate_fk FOREIGN KEY (affiliate_user_id)
          REFERENCES public.affiliate_users(id) ON DELETE CASCADE,
        CONSTRAINT amn_unique UNIQUE (affiliate_user_id, period),
        CONSTRAINT amn_status_check CHECK (status IN
          ('PENDING','PAYABLE','ROLLED_FORWARD','SKIPPED','PAID'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_amn_period ON public.affiliate_monthly_ngr(period);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_amn_status ON public.affiliate_monthly_ngr(status);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.affiliate_monthly_ngr;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.affiliate_revshare_config;`);
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users
        DROP CONSTRAINT IF EXISTS affiliate_payment_method_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users
        DROP COLUMN IF EXISTS revshare_tier,
        DROP COLUMN IF EXISTS revshare_rate,
        DROP COLUMN IF EXISTS payment_method,
        DROP COLUMN IF EXISTS payment_details;
    `);
  }
}

import type{ MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the promotion stack to cover the workflow doc gaps:
 *
 *  A. promotions table → adds eligibility / risk / display fields that the
 *     engine evaluates at apply time (device, frequency, verification gates,
 *     game-category whitelist, anti-fraud uniqueness, apply-amount-min,
 *     auto-unlock threshold).
 *
 *  B. promotion_cms table → ensures it exists (DDL has it but no source-
 *     controlled migration was ever shipped) and adds the missing
 *     `non_eligible_display` column from the doc (GREY / HIDE / DISABLED).
 *
 * Idempotent — safe to re-run.
 */
export class CreatePromotionCms1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════════════════════
    // A. EXTEND promotions WITH ELIGIBILITY / RISK FIELDS
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      ALTER TABLE public.promotions
        ADD COLUMN IF NOT EXISTS device_types               JSONB        NOT NULL DEFAULT '["DESKTOP","MOBILE_WEB","APP"]'::jsonb,
        ADD COLUMN IF NOT EXISTS apply_amount_min           NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS eligible_game_categories   JSONB        NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS auto_unlock_threshold      NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS frequency                  VARCHAR(20)  NOT NULL DEFAULT 'ONE_TIME',
        ADD COLUMN IF NOT EXISTS cooldown_seconds           INTEGER,
        ADD COLUMN IF NOT EXISTS unique_check_bank_account  BOOLEAN      NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS unique_check_email         BOOLEAN      NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS unique_check_ip_address    BOOLEAN      NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS unique_check_device_fp     BOOLEAN      NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS unique_check_phone         BOOLEAN      NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS require_email_verified     BOOLEAN      NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS require_phone_verified     BOOLEAN      NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS require_profile_verified   BOOLEAN      NOT NULL DEFAULT FALSE;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_frequency_check') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_frequency_check
            CHECK (frequency IN ('ONE_TIME','RECURRING_DAILY','RECURRING_WEEKLY','RECURRING_MONTHLY','UNLIMITED'));
        END IF;
      END $$;
    `);

    // ═══════════════════════════════════════════════════════════
    // B. PROMOTION CMS TABLE
    //   (Most installs already have this from the DDL dump, but
    //   IF NOT EXISTS makes this safe to apply to clean DBs.)
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.promotion_cms (
        id                            BIGSERIAL PRIMARY KEY,
        promotion_id                  BIGINT,
        currency                      VARCHAR(10)   NOT NULL DEFAULT 'BDT',
        sequence                      INTEGER       NOT NULL DEFAULT 0,
        tags                          JSONB         NOT NULL DEFAULT '[]'::jsonb,
        display_before_login          BOOLEAN       NOT NULL DEFAULT TRUE,
        display_after_login           BOOLEAN       NOT NULL DEFAULT TRUE,
        show_remaining_time           BOOLEAN       NOT NULL DEFAULT FALSE,
        allow_apply                   BOOLEAN       NOT NULL DEFAULT TRUE,
        redirect_target               VARCHAR(30)   NOT NULL DEFAULT 'PROMO_CENTER',
        eligible_member_group_id      BIGINT,
        starts_at                     TIMESTAMPTZ,
        ends_at                       TIMESTAMPTZ,

        title_en                      VARCHAR(200),
        description_en                TEXT,
        content_en                    TEXT,
        banner_en_url                 TEXT,
        small_banner_en_url           TEXT,

        title_bn                      VARCHAR(200),
        description_bn                TEXT,
        content_bn                    TEXT,
        banner_bn_url                 TEXT,
        small_banner_bn_url           TEXT,

        button_show_with_title        BOOLEAN       NOT NULL DEFAULT FALSE,
        button_show_when_eligible     BOOLEAN       NOT NULL DEFAULT FALSE,
        button_show_in_promotions     BOOLEAN       NOT NULL DEFAULT TRUE,
        button_show_in_promo_center   BOOLEAN       NOT NULL DEFAULT TRUE,

        is_active                     BOOLEAN       NOT NULL DEFAULT TRUE,
        created_by_admin_id           BIGINT,
        updated_by_admin_id           BIGINT,
        created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

        CONSTRAINT promo_cms_redirect_check
          CHECK (redirect_target IN ('PROMO_CENTER','DEPOSIT','VIP','NONE'))
      );
    `);

    // Add the doc's "Display For Non-Eligible User" column (GREY / HIDE / DISABLED)
    await queryRunner.query(`
      ALTER TABLE public.promotion_cms
        ADD COLUMN IF NOT EXISTS non_eligible_display VARCHAR(20) NOT NULL DEFAULT 'GREY';
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_cms_non_eligible_check') THEN
          ALTER TABLE public.promotion_cms
            ADD CONSTRAINT promo_cms_non_eligible_check
            CHECK (non_eligible_display IN ('GREY','HIDE','DISABLED'));
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_cms_promotion_fk') THEN
          ALTER TABLE public.promotion_cms
            ADD CONSTRAINT promo_cms_promotion_fk
            FOREIGN KEY (promotion_id) REFERENCES public.promotions(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_cms_member_group_fk') THEN
          ALTER TABLE public.promotion_cms
            ADD CONSTRAINT promo_cms_member_group_fk
            FOREIGN KEY (eligible_member_group_id) REFERENCES public.member_groups(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // Indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_cms_active_sequence
        ON public.promotion_cms (is_active, sequence);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_cms_currency
        ON public.promotion_cms (currency);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_cms_promotion_id
        ON public.promotion_cms (promotion_id) WHERE promotion_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_cms_tags_gin
        ON public.promotion_cms USING GIN (tags);
    `);

    // updated_at trigger reuses existing set_updated_at() function
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at')
           AND NOT EXISTS (
             SELECT 1 FROM pg_trigger WHERE tgname = 'promotion_cms_set_updated_at'
           ) THEN
          CREATE TRIGGER promotion_cms_set_updated_at
            BEFORE UPDATE ON public.promotion_cms
            FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
        END IF;
      END $$;
    `);

    // ═══════════════════════════════════════════════════════════
    // C. CLAIM FRAUD-CHECK SUPPORT
    //   Add the columns we need on user_promotion_claims to support
    //   anti-fraud uniqueness checks (bank/ip/device/email/phone).
    //   These are captured at claim time so we can match future claims
    //   against historical claims.
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      ALTER TABLE public.user_promotion_claims
        ADD COLUMN IF NOT EXISTS ip_address          VARCHAR(64),
        ADD COLUMN IF NOT EXISTS device_fingerprint  VARCHAR(128);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_upc_ip
        ON public.user_promotion_claims (ip_address)
        WHERE ip_address IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_upc_device_fp
        ON public.user_promotion_claims (device_fingerprint)
        WHERE device_fingerprint IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.promotion_cms;`);

    await queryRunner.query(`
      ALTER TABLE public.promotions
        DROP CONSTRAINT IF EXISTS promotions_frequency_check;
    `);

    await queryRunner.query(`
      ALTER TABLE public.promotions
        DROP COLUMN IF EXISTS device_types,
        DROP COLUMN IF EXISTS apply_amount_min,
        DROP COLUMN IF EXISTS eligible_game_categories,
        DROP COLUMN IF EXISTS auto_unlock_threshold,
        DROP COLUMN IF EXISTS frequency,
        DROP COLUMN IF EXISTS cooldown_seconds,
        DROP COLUMN IF EXISTS unique_check_bank_account,
        DROP COLUMN IF EXISTS unique_check_email,
        DROP COLUMN IF EXISTS unique_check_ip_address,
        DROP COLUMN IF EXISTS unique_check_device_fp,
        DROP COLUMN IF EXISTS unique_check_phone,
        DROP COLUMN IF EXISTS require_email_verified,
        DROP COLUMN IF EXISTS require_phone_verified,
        DROP COLUMN IF EXISTS require_profile_verified;
    `);

    await queryRunner.query(`
      ALTER TABLE public.user_promotion_claims
        DROP COLUMN IF EXISTS ip_address,
        DROP COLUMN IF EXISTS device_fingerprint;
    `);
  }
}
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Completes the Promotion Engine to match build-guide §5.2 / §8.
 *
 * Adds the bonus-rule fields that the EditPromotionModal exposes but the
 * original schema never stored: claim approval/lifecycle toggles, forfeit
 * config, target (wagering) configuration, withdrawal caps, distinct-player
 * cap, and CMS-visibility hints. Also widens the claim state machine so a
 * claim can move APPLIED → APPROVED → ACTIVE → COMPLETED / FORFEITED.
 */
export class CompletePromotionEngine1780100000000 implements MigrationInterface {
  name = 'CompletePromotionEngine1780100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── promotions: new engine fields ────────────────────────────
    await queryRunner.query(`
      ALTER TABLE public.promotions
        ADD COLUMN IF NOT EXISTS linked_promotion_id      BIGINT,
        ADD COLUMN IF NOT EXISTS auto_approve             BOOLEAN       NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS auto_complete            BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS allow_cancel             BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS cancel_threshold         NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS forfeit_type             VARCHAR(20)   NOT NULL DEFAULT 'BONUS',
        ADD COLUMN IF NOT EXISTS maximum_withdrawal       NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS amount_cap               NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS cap_limit_type           VARCHAR(20),
        ADD COLUMN IF NOT EXISTS balance_require          NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS remove_max_withdraw_lock BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS target_type              VARCHAR(20)   NOT NULL DEFAULT 'TURNOVER',
        ADD COLUMN IF NOT EXISTS target_option            VARCHAR(30)   NOT NULL DEFAULT 'BONUS_AND_APPLY',
        ADD COLUMN IF NOT EXISTS max_player               INTEGER,
        ADD COLUMN IF NOT EXISTS pay_later                BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS display_if_non_eligible  BOOLEAN       NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS hide_if_eligible         BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS limit_to_provider        BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS check_by_wallet_balance  BOOLEAN       NOT NULL DEFAULT FALSE;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_linked_fk') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_linked_fk
            FOREIGN KEY (linked_promotion_id)
            REFERENCES public.promotions(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_forfeit_type_check') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_forfeit_type_check
            CHECK (forfeit_type IN ('WALLET','BONUS'));
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_target_type_check') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_target_type_check
            CHECK (target_type IN ('TURNOVER','DEPOSIT','WIN_LOSS'));
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_target_option_check') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_target_option_check
            CHECK (target_option IN ('BONUS_AND_APPLY','BONUS_ONLY','APPLY_ONLY'));
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_cap_limit_type_check') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_cap_limit_type_check
            CHECK (cap_limit_type IS NULL OR cap_limit_type IN ('AMOUNT','PERCENT'));
        END IF;
      END $$;
    `);

    // ── user_promotion_claims: widen state machine + lifecycle cols ──
    await queryRunner.query(`
      ALTER TABLE public.user_promotion_claims
        ADD COLUMN IF NOT EXISTS approved_at          TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS approved_by_admin_id BIGINT,
        ADD COLUMN IF NOT EXISTS forfeited_at         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS forfeit_type         VARCHAR(20),
        ADD COLUMN IF NOT EXISTS forfeit_reason       TEXT;
    `);

    // Replace the status CHECK with the extended state set.
    await queryRunner.query(`
      ALTER TABLE public.user_promotion_claims
        DROP CONSTRAINT IF EXISTS upc_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.user_promotion_claims
        ADD CONSTRAINT upc_status_check
        CHECK (status IN ('PENDING','APPLIED','APPROVED','ACTIVE','COMPLETED','CANCELLED','EXPIRED','FORFEITED'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.user_promotion_claims
        DROP CONSTRAINT IF EXISTS upc_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.user_promotion_claims
        ADD CONSTRAINT upc_status_check
        CHECK (status IN ('PENDING','ACTIVE','COMPLETED','CANCELLED','EXPIRED'));
    `);
    await queryRunner.query(`
      ALTER TABLE public.user_promotion_claims
        DROP COLUMN IF EXISTS approved_at,
        DROP COLUMN IF EXISTS approved_by_admin_id,
        DROP COLUMN IF EXISTS forfeited_at,
        DROP COLUMN IF EXISTS forfeit_type,
        DROP COLUMN IF EXISTS forfeit_reason;
    `);

    await queryRunner.query(`
      ALTER TABLE public.promotions
        DROP CONSTRAINT IF EXISTS promotions_linked_fk,
        DROP CONSTRAINT IF EXISTS promotions_forfeit_type_check,
        DROP CONSTRAINT IF EXISTS promotions_target_type_check,
        DROP CONSTRAINT IF EXISTS promotions_target_option_check,
        DROP CONSTRAINT IF EXISTS promotions_cap_limit_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.promotions
        DROP COLUMN IF EXISTS linked_promotion_id,
        DROP COLUMN IF EXISTS auto_approve,
        DROP COLUMN IF EXISTS auto_complete,
        DROP COLUMN IF EXISTS allow_cancel,
        DROP COLUMN IF EXISTS cancel_threshold,
        DROP COLUMN IF EXISTS forfeit_type,
        DROP COLUMN IF EXISTS maximum_withdrawal,
        DROP COLUMN IF EXISTS amount_cap,
        DROP COLUMN IF EXISTS cap_limit_type,
        DROP COLUMN IF EXISTS balance_require,
        DROP COLUMN IF EXISTS remove_max_withdraw_lock,
        DROP COLUMN IF EXISTS target_type,
        DROP COLUMN IF EXISTS target_option,
        DROP COLUMN IF EXISTS max_player,
        DROP COLUMN IF EXISTS pay_later,
        DROP COLUMN IF EXISTS display_if_non_eligible,
        DROP COLUMN IF EXISTS hide_if_eligible,
        DROP COLUMN IF EXISTS limit_to_provider,
        DROP COLUMN IF EXISTS check_by_wallet_balance;
    `);
  }
}

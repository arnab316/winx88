import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePromotionEngine1680000000004 implements MigrationInterface {
  name = 'CreatePromotionEngine1680000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════════════════════
    // 1. MEMBER GROUPS
    //   Admin-defined user segments (e.g. "New Users", "VIPs",
    //   "Cricket Bettors", "Inactive 30+ Days").
    //   A user can belong to multiple groups via member_group_users.
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.member_groups (
        id                  BIGSERIAL PRIMARY KEY,
        name                VARCHAR(100)  NOT NULL,
        code                VARCHAR(40)   NOT NULL UNIQUE,
        description         TEXT,
        is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
        is_system           BOOLEAN       NOT NULL DEFAULT FALSE,
        created_by_admin_id BIGINT,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_member_groups_active
        ON public.member_groups(is_active);
    `);

    // ═══════════════════════════════════════════════════════════
    // 2. MEMBER GROUP MEMBERSHIP (many-to-many)
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.member_group_users (
        id           BIGSERIAL PRIMARY KEY,
        group_id     BIGINT       NOT NULL,
        user_id      BIGINT       NOT NULL,
        added_by     BIGINT,
        added_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT mgu_group_fk FOREIGN KEY (group_id)
          REFERENCES public.member_groups(id) ON DELETE CASCADE,
        CONSTRAINT mgu_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT mgu_unique UNIQUE (group_id, user_id)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mgu_user ON public.member_group_users(user_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mgu_group ON public.member_group_users(group_id);
    `);

    // ═══════════════════════════════════════════════════════════
    // 3. SEED DEFAULT MEMBER GROUPS
    //   "ALL" is a sentinel — promos targeting ALL skip group check.
    //   Real users are NOT auto-added to ALL; the engine treats it specially.
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      INSERT INTO public.member_groups (code, name, description, is_system)
      SELECT * FROM (VALUES
        ('ALL',         'All Members',     'Default: every user qualifies',                  TRUE),
        ('NEW_USERS',   'New Users',       'Users registered in last 7 days',                TRUE),
        ('VIP',         'VIP Members',     'Users with VIP level >= 3',                      TRUE)
      ) AS v(code, name, description, is_system)
      WHERE NOT EXISTS (SELECT 1 FROM public.member_groups mg WHERE mg.code = v.code);
    `);

    // ═══════════════════════════════════════════════════════════
    // 4. EXTEND promotions table
    //   Adds: kind, rollover_multiplier, max uses, member group,
    //         max bonus pool (Promotion Max Total in your screenshots),
    //         applies_to, currency
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      ALTER TABLE public.promotions
        ADD COLUMN IF NOT EXISTS kind                 VARCHAR(30)  NOT NULL DEFAULT 'DEPOSIT',
        ADD COLUMN IF NOT EXISTS rollover_multiplier  NUMERIC(6,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS member_group_id      BIGINT,
        ADD COLUMN IF NOT EXISTS max_uses_per_user    INTEGER      NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS max_uses_global      INTEGER,
        ADD COLUMN IF NOT EXISTS uses_count           INTEGER      NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS max_bonus_pool       NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS bonus_paid_total     NUMERIC(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS currency             VARCHAR(10)  NOT NULL DEFAULT 'BDT',
        ADD COLUMN IF NOT EXISTS bonus_to             VARCHAR(20)  NOT NULL DEFAULT 'BONUS_BALANCE',
        ADD COLUMN IF NOT EXISTS created_by_admin_id  BIGINT,
        ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW();
    `);

    // Constraints (DO block for re-run safety)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_kind_check') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_kind_check
            CHECK (kind IN ('DEPOSIT','REGISTRATION','PROMOCODE','MANUAL','FREE_REWARD','RELOAD','CASHBACK'));
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_bonus_to_check') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_bonus_to_check
            CHECK (bonus_to IN ('BONUS_BALANCE','MAIN_BALANCE'));
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_member_group_fk') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_member_group_fk
            FOREIGN KEY (member_group_id)
            REFERENCES public.member_groups(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_amounts_check') THEN
          ALTER TABLE public.promotions
            ADD CONSTRAINT promotions_amounts_check
            CHECK (
              uses_count >= 0
              AND bonus_paid_total >= 0
              AND rollover_multiplier >= 0
              AND (max_uses_global IS NULL OR max_uses_global > 0)
              AND (max_bonus_pool IS NULL OR max_bonus_pool > 0)
            );
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promotions_kind_active
        ON public.promotions(kind, is_active);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promotions_code
        ON public.promotions(code) WHERE code IS NOT NULL;
    `);

    // ═══════════════════════════════════════════════════════════
    // 5. USER PROMOTION CLAIMS
    //   One row per (user, promotion, claim attempt).
    //   Tracks the entire lifecycle: PENDING → ACTIVE → COMPLETED/CANCELLED
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.user_promotion_claims (
        id                    BIGSERIAL PRIMARY KEY,
        user_id               BIGINT         NOT NULL,
        promotion_id          BIGINT         NOT NULL,
        deposit_id            BIGINT,
        bonus_amount          NUMERIC(18,2)  NOT NULL,
        rollover_target       NUMERIC(18,2)  NOT NULL DEFAULT 0,
        turnover_requirement_id BIGINT,
        status                VARCHAR(20)    NOT NULL DEFAULT 'ACTIVE',
        claimed_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        completed_at          TIMESTAMPTZ,
        cancelled_at          TIMESTAMPTZ,
        cancellation_reason   TEXT,
        meta                  JSONB,

        CONSTRAINT upc_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT upc_promotion_fk FOREIGN KEY (promotion_id)
          REFERENCES public.promotions(id) ON DELETE RESTRICT,
        CONSTRAINT upc_deposit_fk FOREIGN KEY (deposit_id)
          REFERENCES public.deposits(id) ON DELETE SET NULL,
        CONSTRAINT upc_turnover_fk FOREIGN KEY (turnover_requirement_id)
          REFERENCES public.turnover_requirements(id) ON DELETE SET NULL,
        CONSTRAINT upc_status_check CHECK (status IN ('PENDING','ACTIVE','COMPLETED','CANCELLED','EXPIRED')),
        CONSTRAINT upc_amount_check CHECK (bonus_amount >= 0)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_upc_user_status
        ON public.user_promotion_claims(user_id, status);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_upc_promotion
        ON public.user_promotion_claims(promotion_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_upc_deposit
        ON public.user_promotion_claims(deposit_id) WHERE deposit_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.user_promotion_claims;`);

    // Drop new columns from promotions (keep the original DDL columns intact)
    await queryRunner.query(`
      ALTER TABLE public.promotions
        DROP CONSTRAINT IF EXISTS promotions_kind_check,
        DROP CONSTRAINT IF EXISTS promotions_bonus_to_check,
        DROP CONSTRAINT IF EXISTS promotions_member_group_fk,
        DROP CONSTRAINT IF EXISTS promotions_amounts_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.promotions
        DROP COLUMN IF EXISTS kind,
        DROP COLUMN IF EXISTS rollover_multiplier,
        DROP COLUMN IF EXISTS member_group_id,
        DROP COLUMN IF EXISTS max_uses_per_user,
        DROP COLUMN IF EXISTS max_uses_global,
        DROP COLUMN IF EXISTS uses_count,
        DROP COLUMN IF EXISTS max_bonus_pool,
        DROP COLUMN IF EXISTS bonus_paid_total,
        DROP COLUMN IF EXISTS currency,
        DROP COLUMN IF EXISTS bonus_to,
        DROP COLUMN IF EXISTS created_by_admin_id,
        DROP COLUMN IF EXISTS updated_at;
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS public.member_group_users;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.member_groups;`);
  }
}
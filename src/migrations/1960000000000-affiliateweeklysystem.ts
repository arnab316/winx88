import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Affiliate weekly commission system (Figma "Promotion Settings" affiliate
 * user-panel + admin-panel designs).
 *
 * Adds on top of the existing affiliate + RevShare layers:
 *  - affiliate_groups            admin-defined tiers (name, revshare %, min/max
 *                                active players) replacing the hardcoded ladder
 *                                as the primary rate source.
 *  - affiliate_users             + group_id, commission_balance,
 *                                lifetime_commission, status (active/inactive/
 *                                suspended/locked), remark.
 *  - affiliate_weekly_commission one row per (affiliate, Friday-to-Friday week):
 *                                real-cash deposits − withdrawals of the
 *                                downline, active-player count, rate, credited
 *                                commission.
 *  - affiliate_weekly_player_stats  per-player audit of each weekly row
 *                                (deposits, withdrawals, net, counted flag —
 *                                "no bonus" players have counted = FALSE).
 *  - affiliate_transfers         affiliate → player commission transfers,
 *                                admin-approved.
 *  - affiliate_commission_ledger every movement of an affiliate's commission
 *                                balance (weekly credit, transfer hold/refund).
 *  - financial_ledger            entry_type + AFFILIATE_COMMISSION_CREDIT and
 *                                reference_type + AFFILIATE_TRANSFER so an
 *                                approved transfer shows up in the recipient's
 *                                transaction history.
 */
export class AffiliateWeeklySystem1960000000000 implements MigrationInterface {
  name = 'AffiliateWeeklySystem1960000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── affiliate_groups ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.affiliate_groups (
        id                  BIGSERIAL PRIMARY KEY,
        name                VARCHAR(80)   NOT NULL,
        rev_share_pct       NUMERIC(5,2)  NOT NULL,
        min_active_players  INTEGER       NOT NULL DEFAULT 0,
        max_active_players  INTEGER,               -- NULL = no upper bound
        is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
        created_by_admin_id BIGINT,                -- admin_users.id, no FK
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT affiliate_groups_name_unique UNIQUE (name),
        CONSTRAINT affiliate_groups_pct_check
          CHECK (rev_share_pct >= 0 AND rev_share_pct <= 100),
        CONSTRAINT affiliate_groups_range_check
          CHECK (min_active_players >= 0 AND
                 (max_active_players IS NULL OR max_active_players >= min_active_players))
      );
    `);
    // Seed the four tiers the RevShare config ladder already encodes.
    await queryRunner.query(`
      INSERT INTO public.affiliate_groups
        (name, rev_share_pct, min_active_players, max_active_players)
      VALUES
        ('Starter',     25, 0,  10),
        ('Growth',      30, 11, 30),
        ('Pro',         35, 31, 50),
        ('VIP Partner', 40, 51, NULL)
      ON CONFLICT (name) DO NOTHING;
    `);

    // ── affiliate_users: group, commission balance, status ────────
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users
        ADD COLUMN IF NOT EXISTS group_id            BIGINT
          REFERENCES public.affiliate_groups(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS commission_balance  NUMERIC(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS lifetime_commission NUMERIC(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS status              VARCHAR(12)   NOT NULL DEFAULT 'ACTIVE',
        ADD COLUMN IF NOT EXISTS remark              TEXT;
    `);
    await queryRunner.query(`
      UPDATE public.affiliate_users
         SET status = CASE WHEN is_active THEN 'ACTIVE' ELSE 'INACTIVE' END
       WHERE status NOT IN ('ACTIVE','INACTIVE','SUSPENDED','LOCKED');
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_users_status_check') THEN
          ALTER TABLE public.affiliate_users
            ADD CONSTRAINT affiliate_users_status_check
            CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED','LOCKED'));
        END IF;
      END $$;
    `);

    // ── affiliate_weekly_commission ───────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.affiliate_weekly_commission (
        id                    BIGSERIAL PRIMARY KEY,
        affiliate_user_id     BIGINT        NOT NULL,
        week_start            DATE          NOT NULL,  -- Friday (inclusive)
        week_end              DATE          NOT NULL,  -- next Friday (exclusive)
        total_deposits        NUMERIC(18,2) NOT NULL DEFAULT 0,
        total_withdrawals     NUMERIC(18,2) NOT NULL DEFAULT 0,
        net_amount            NUMERIC(18,2) NOT NULL DEFAULT 0, -- Σ per-player max(dep−wd, 0)
        active_player_count   INTEGER       NOT NULL DEFAULT 0,
        no_bonus_player_count INTEGER       NOT NULL DEFAULT 0,
        revshare_rate         NUMERIC(5,2)  NOT NULL DEFAULT 0,
        commission            NUMERIC(18,2) NOT NULL DEFAULT 0,
        status                VARCHAR(12)   NOT NULL DEFAULT 'NO_BONUS',
        computed_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        credited_at           TIMESTAMPTZ,
        created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT awc_affiliate_fk FOREIGN KEY (affiliate_user_id)
          REFERENCES public.affiliate_users(id) ON DELETE CASCADE,
        CONSTRAINT awc_unique UNIQUE (affiliate_user_id, week_start),
        CONSTRAINT awc_status_check CHECK (status IN ('CREDITED','NO_BONUS'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_awc_week_start
        ON public.affiliate_weekly_commission(week_start);
    `);

    // ── affiliate_weekly_player_stats ─────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.affiliate_weekly_player_stats (
        id          BIGSERIAL PRIMARY KEY,
        weekly_id   BIGINT        NOT NULL,
        user_id     BIGINT        NOT NULL,
        deposits    NUMERIC(18,2) NOT NULL DEFAULT 0,
        withdrawals NUMERIC(18,2) NOT NULL DEFAULT 0,
        net         NUMERIC(18,2) NOT NULL DEFAULT 0,
        is_active   BOOLEAN       NOT NULL DEFAULT FALSE, -- deposited this week
        counted     BOOLEAN       NOT NULL DEFAULT FALSE, -- contributed to commission
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT awps_weekly_fk FOREIGN KEY (weekly_id)
          REFERENCES public.affiliate_weekly_commission(id) ON DELETE CASCADE,
        CONSTRAINT awps_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT awps_unique UNIQUE (weekly_id, user_id)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_awps_user ON public.affiliate_weekly_player_stats(user_id);
    `);

    // ── affiliate_transfers ───────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.affiliate_transfers (
        id                  BIGSERIAL PRIMARY KEY,
        affiliate_user_id   BIGINT        NOT NULL,
        from_user_id        BIGINT        NOT NULL,
        to_user_id          BIGINT        NOT NULL,
        amount              NUMERIC(18,2) NOT NULL,
        status              VARCHAR(12)   NOT NULL DEFAULT 'PENDING',
        note                TEXT,
        requested_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        decided_at          TIMESTAMPTZ,
        decided_by_admin_id BIGINT,               -- admin_users.id, no FK
        rejection_reason    TEXT,
        ledger_id           BIGINT,               -- financial_ledger row on approval
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT atr_affiliate_fk FOREIGN KEY (affiliate_user_id)
          REFERENCES public.affiliate_users(id) ON DELETE CASCADE,
        CONSTRAINT atr_from_fk FOREIGN KEY (from_user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT atr_to_fk FOREIGN KEY (to_user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT atr_amount_check CHECK (amount > 0),
        CONSTRAINT atr_status_check CHECK (status IN ('PENDING','APPROVED','REJECTED'))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_atr_affiliate ON public.affiliate_transfers(affiliate_user_id, status);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_atr_recipient ON public.affiliate_transfers(to_user_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_atr_status ON public.affiliate_transfers(status);
    `);

    // ── affiliate_commission_ledger ───────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.affiliate_commission_ledger (
        id                BIGSERIAL PRIMARY KEY,
        affiliate_user_id BIGINT        NOT NULL,
        entry_type        VARCHAR(30)   NOT NULL,
        flow              VARCHAR(6)    NOT NULL,
        amount            NUMERIC(18,2) NOT NULL,
        balance_before    NUMERIC(18,2) NOT NULL,
        balance_after     NUMERIC(18,2) NOT NULL,
        reference_type    VARCHAR(30),
        reference_id      BIGINT,
        description       TEXT,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT acl_affiliate_fk FOREIGN KEY (affiliate_user_id)
          REFERENCES public.affiliate_users(id) ON DELETE CASCADE,
        CONSTRAINT acl_entry_check CHECK (entry_type IN
          ('WEEKLY_COMMISSION','TRANSFER_REQUEST','TRANSFER_REFUND','ADMIN_ADJUST')),
        CONSTRAINT acl_flow_check CHECK (flow IN ('CREDIT','DEBIT')),
        CONSTRAINT acl_amount_check CHECK (amount >= 0)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_acl_affiliate ON public.affiliate_commission_ledger(affiliate_user_id);
    `);

    // ── financial_ledger: allow the affiliate-transfer credit ─────
    await queryRunner.query(`
      ALTER TABLE public.financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_entry_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.financial_ledger ADD CONSTRAINT financial_ledger_entry_type_check
        CHECK (entry_type IN (
          'DEPOSIT_PENDING','DEPOSIT_APPROVED','DEPOSIT_REJECTED',
          'BET_PLACED','BET_CANCELLED','WIN_CREDIT','REFERRAL_BONUS_CREDIT',
          'WITHDRAWAL_REQUESTED','WITHDRAWAL_APPROVED','WITHDRAWAL_REJECTED',
          'MANUAL_ADJUSTMENT','MANUAL_DEPOSIT','PROMOTION_BONUS',
          'AFFILIATE_COMMISSION_CREDIT'
        ));
    `);
    await queryRunner.query(`
      ALTER TABLE public.financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_reference_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.financial_ledger ADD CONSTRAINT financial_ledger_reference_type_check
        CHECK (reference_type IN (
          'DEPOSIT','WITHDRAWAL','BET','BET_SETTLEMENT','REFERRAL_BONUS',
          'MANUAL_ADJUSTMENT','PROMOTION','AFFILIATE_TRANSFER'
        ));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_reference_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.financial_ledger ADD CONSTRAINT financial_ledger_reference_type_check
        CHECK (reference_type IN (
          'DEPOSIT','WITHDRAWAL','BET','BET_SETTLEMENT','REFERRAL_BONUS',
          'MANUAL_ADJUSTMENT','PROMOTION'
        ));
    `);
    await queryRunner.query(`
      ALTER TABLE public.financial_ledger DROP CONSTRAINT IF EXISTS financial_ledger_entry_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.financial_ledger ADD CONSTRAINT financial_ledger_entry_type_check
        CHECK (entry_type IN (
          'DEPOSIT_PENDING','DEPOSIT_APPROVED','DEPOSIT_REJECTED',
          'BET_PLACED','BET_CANCELLED','WIN_CREDIT','REFERRAL_BONUS_CREDIT',
          'WITHDRAWAL_REQUESTED','WITHDRAWAL_APPROVED','WITHDRAWAL_REJECTED',
          'MANUAL_ADJUSTMENT','MANUAL_DEPOSIT','PROMOTION_BONUS'
        ));
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS public.affiliate_commission_ledger;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.affiliate_transfers;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.affiliate_weekly_player_stats;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.affiliate_weekly_commission;`);
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users
        DROP CONSTRAINT IF EXISTS affiliate_users_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users
        DROP COLUMN IF EXISTS group_id,
        DROP COLUMN IF EXISTS commission_balance,
        DROP COLUMN IF EXISTS lifetime_commission,
        DROP COLUMN IF EXISTS status,
        DROP COLUMN IF EXISTS remark;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS public.affiliate_groups;`);
  }
}

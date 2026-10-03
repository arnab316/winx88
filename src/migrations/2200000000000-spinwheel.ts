import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SPIN WHEEL — scheduled prize wheel.
 *
 * Three tables, mirroring how the promotion engine already splits things:
 *
 *   spin_wheels           the wheel + its schedule + who may spin it
 *   spin_wheel_segments   one row per pie slice (prize, odds, turnover)
 *   spin_results          one row per spin, the audit trail
 *
 * A prize is NOT a new kind of money. It is credited through the same path a
 * promotion bonus takes — into `bonus_balance` and `balance` together — and it
 * raises a normal `turnover_requirements` row, so the wagering page, the
 * withdrawal gate and the reports keep working without knowing spins exist.
 *
 * The odds live in `weight` and are never sent to the client; the winning
 * segment is chosen server-side. A client that could pick its own slice would
 * pick the top prize every time.
 *
 * Idempotent.
 */
export class SpinWheel2200000000000 implements MigrationInterface {
  name = 'SpinWheel2200000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── the wheel ────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.spin_wheels (
        id                    BIGSERIAL    PRIMARY KEY,
        name                  VARCHAR(120) NOT NULL,
        currency              VARCHAR(10)  NOT NULL DEFAULT 'BDT',

        -- The client renders 4 or 6 slices. Anything else is a wheel the
        -- frontend cannot draw, so it is rejected here rather than at runtime.
        segment_count         SMALLINT     NOT NULL DEFAULT 6,

        -- Schedule. WEEKLY + day_of_week + start_time is the common case:
        -- "every Friday 18:00, open for 120 minutes".
        frequency             VARCHAR(10)  NOT NULL DEFAULT 'WEEKLY',
        day_of_week           SMALLINT,
        day_of_month          SMALLINT,
        start_time            TIME         NOT NULL DEFAULT '00:00',
        -- NULL = the window stays open for the whole period, so the player can
        -- take their weekly spin whenever they like.
        window_minutes        INTEGER,
        timezone              VARCHAR(64)  NOT NULL DEFAULT 'Asia/Dhaka',

        spins_per_window      SMALLINT     NOT NULL DEFAULT 1,

        -- Where the prize lands. BONUS_BALANCE shows it to the player as a
        -- bonus and keeps it behind the turnover gate.
        bonus_to              VARCHAR(20)  NOT NULL DEFAULT 'BONUS_BALANCE',

        -- Who may spin. All three are optional gates; left unset the wheel is
        -- open to every player.
        min_vip_level         SMALLINT     NOT NULL DEFAULT 0,
        member_group_id       BIGINT       REFERENCES public.member_groups(id) ON DELETE SET NULL,
        -- Require the player to have deposited this much inside the window
        -- before the wheel unlocks.
        min_deposit_in_window NUMERIC(18,2),

        -- Campaign life, separate from the recurring schedule.
        starts_at             TIMESTAMPTZ,
        ends_at               TIMESTAMPTZ,

        is_active             BOOLEAN      NOT NULL DEFAULT FALSE,

        created_by_admin_id   BIGINT,
        updated_by_admin_id   BIGINT,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT spin_wheels_segment_count_check
          CHECK (segment_count IN (4, 6)),
        CONSTRAINT spin_wheels_frequency_check
          CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
        CONSTRAINT spin_wheels_dow_check
          CHECK (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6),
        -- Capped at 28 so a monthly wheel exists in February too.
        CONSTRAINT spin_wheels_dom_check
          CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28),
        CONSTRAINT spin_wheels_bonus_to_check
          CHECK (bonus_to IN ('BONUS_BALANCE', 'MAIN_BALANCE')),
        CONSTRAINT spin_wheels_spins_check
          CHECK (spins_per_window >= 1),
        CONSTRAINT spin_wheels_window_minutes_check
          CHECK (window_minutes IS NULL OR window_minutes > 0)
      );
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_spin_wheels_live
        ON public.spin_wheels (currency, id)
        WHERE is_active = TRUE;
    `);

    // ── the slices ───────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.spin_wheel_segments (
        id                  BIGSERIAL     PRIMARY KEY,
        wheel_id            BIGINT        NOT NULL
                              REFERENCES public.spin_wheels(id) ON DELETE CASCADE,

        -- 0-based, clockwise from the top. The client animates to this index.
        position            SMALLINT      NOT NULL,
        label               VARCHAR(80),

        -- The prize. 0 is a legitimate slice — a wheel needs losing segments.
        amount              NUMERIC(18,2) NOT NULL DEFAULT 0,

        -- Turnover this prize carries, set per slice by the admin. The
        -- requirement raised is amount x turnover_multiplier; 0 means the prize
        -- is withdrawable immediately.
        turnover_multiplier NUMERIC(10,2) NOT NULL DEFAULT 0,

        -- Relative odds, never exposed to the client. Equal weights give a fair
        -- wheel; raise the weight on small prizes to control payout.
        weight              INTEGER       NOT NULL DEFAULT 1,

        color               VARCHAR(20),
        is_active           BOOLEAN       NOT NULL DEFAULT TRUE,

        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

        CONSTRAINT spin_segments_position_check CHECK (position BETWEEN 0 AND 5),
        CONSTRAINT spin_segments_amount_check   CHECK (amount >= 0),
        CONSTRAINT spin_segments_turnover_check CHECK (turnover_multiplier >= 0),
        CONSTRAINT spin_segments_weight_check   CHECK (weight >= 0),
        CONSTRAINT spin_segments_unique_position UNIQUE (wheel_id, position)
      );
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_spin_segments_wheel
        ON public.spin_wheel_segments (wheel_id, position);
    `);

    // ── the audit trail ──────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.spin_results (
        id                      BIGSERIAL     PRIMARY KEY,
        user_id                 BIGINT        NOT NULL
                                  REFERENCES public.users(id) ON DELETE CASCADE,
        wheel_id                BIGINT        NOT NULL
                                  REFERENCES public.spin_wheels(id) ON DELETE CASCADE,
        -- Nullable so retiring a slice never destroys the payout history.
        segment_id              BIGINT        REFERENCES public.spin_wheel_segments(id) ON DELETE SET NULL,

        -- Snapshots. The wheel can be re-tuned tomorrow; what was won must not
        -- change with it.
        segment_position        SMALLINT      NOT NULL,
        segment_label           VARCHAR(80),
        amount                  NUMERIC(18,2) NOT NULL DEFAULT 0,
        turnover_multiplier     NUMERIC(10,2) NOT NULL DEFAULT 0,
        turnover_target         NUMERIC(18,2) NOT NULL DEFAULT 0,
        turnover_requirement_id BIGINT,

        -- Which occurrence of the schedule this spin belongs to. Together with
        -- spin_index it is what stops a double-tap becoming two spins.
        window_start            TIMESTAMPTZ   NOT NULL,
        window_end              TIMESTAMPTZ   NOT NULL,
        spin_index              SMALLINT      NOT NULL DEFAULT 0,

        ip_address              VARCHAR(64),
        device_fingerprint      VARCHAR(128),
        created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

        -- Race-safe quota. Two concurrent requests compute the same spin_index;
        -- the second loses here rather than paying twice.
        CONSTRAINT spin_results_one_per_slot
          UNIQUE (user_id, wheel_id, window_start, spin_index)
      );
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_spin_results_user
        ON public.spin_results (user_id, created_at DESC);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_spin_results_wheel
        ON public.spin_results (wheel_id, created_at DESC);
    `);

    // ── let the shared plumbing describe a spin ──────────────────
    // turnover_requirements.source_type and the financial ledger both carry
    // CHECK constraints listing every known source. A spin has to be added to
    // them or the inserts fail.
    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP CONSTRAINT IF EXISTS turnover_req_source_type_check;
    `);
    await q.query(`
      ALTER TABLE public.turnover_requirements
        ADD CONSTRAINT turnover_req_source_type_check
        CHECK (source_type IN ('DEPOSIT','PROMOTION','MANUAL','BONUS','SPIN'));
    `);

    await q.query(`
      ALTER TABLE public.financial_ledger
        DROP CONSTRAINT IF EXISTS financial_ledger_entry_type_check;
    `);
    await q.query(`
      ALTER TABLE public.financial_ledger
        ADD CONSTRAINT financial_ledger_entry_type_check
        CHECK (entry_type IN (
          'DEPOSIT_PENDING','DEPOSIT_APPROVED','DEPOSIT_REJECTED',
          'BET_PLACED','BET_CANCELLED','WIN_CREDIT','REFERRAL_BONUS_CREDIT',
          'WITHDRAWAL_REQUESTED','WITHDRAWAL_APPROVED','WITHDRAWAL_REJECTED',
          'MANUAL_ADJUSTMENT','MANUAL_DEPOSIT','PROMOTION_BONUS',
          'AFFILIATE_COMMISSION_CREDIT','SPIN_WIN'
        ));
    `);

    await q.query(`
      ALTER TABLE public.financial_ledger
        DROP CONSTRAINT IF EXISTS financial_ledger_reference_type_check;
    `);
    await q.query(`
      ALTER TABLE public.financial_ledger
        ADD CONSTRAINT financial_ledger_reference_type_check
        CHECK (reference_type IN (
          'DEPOSIT','WITHDRAWAL','BET','BET_SETTLEMENT','REFERRAL_BONUS',
          'MANUAL_ADJUSTMENT','PROMOTION','AFFILIATE_TRANSFER','SPIN'
        ));
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS public.spin_results;`);
    await q.query(`DROP TABLE IF EXISTS public.spin_wheel_segments;`);
    await q.query(`DROP TABLE IF EXISTS public.spin_wheels;`);

    // Put the shared constraints back the way they were.
    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP CONSTRAINT IF EXISTS turnover_req_source_type_check;
    `);
    await q.query(`
      ALTER TABLE public.turnover_requirements
        ADD CONSTRAINT turnover_req_source_type_check
        CHECK (source_type IN ('DEPOSIT','PROMOTION','MANUAL','BONUS'));
    `);
    await q.query(`
      ALTER TABLE public.financial_ledger
        DROP CONSTRAINT IF EXISTS financial_ledger_entry_type_check;
    `);
    await q.query(`
      ALTER TABLE public.financial_ledger
        ADD CONSTRAINT financial_ledger_entry_type_check
        CHECK (entry_type IN (
          'DEPOSIT_PENDING','DEPOSIT_APPROVED','DEPOSIT_REJECTED',
          'BET_PLACED','BET_CANCELLED','WIN_CREDIT','REFERRAL_BONUS_CREDIT',
          'WITHDRAWAL_REQUESTED','WITHDRAWAL_APPROVED','WITHDRAWAL_REJECTED',
          'MANUAL_ADJUSTMENT','MANUAL_DEPOSIT','PROMOTION_BONUS',
          'AFFILIATE_COMMISSION_CREDIT'
        ));
    `);
    await q.query(`
      ALTER TABLE public.financial_ledger
        DROP CONSTRAINT IF EXISTS financial_ledger_reference_type_check;
    `);
    await q.query(`
      ALTER TABLE public.financial_ledger
        ADD CONSTRAINT financial_ledger_reference_type_check
        CHECK (reference_type IN (
          'DEPOSIT','WITHDRAWAL','BET','BET_SETTLEMENT','REFERRAL_BONUS',
          'MANUAL_ADJUSTMENT','PROMOTION','AFFILIATE_TRANSFER'
        ));
    `);
  }
}

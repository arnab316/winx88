import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cashback, Rebate and Manual promotions.
 *
 * `CASHBACK` and `REBATE` have been in PROMOTION_KINDS since the engine was
 * written, but nothing implemented them — picking one produced an ordinary
 * deposit bonus. This is the configuration behind them.
 *
 * ── The shape ────────────────────────────────────────────────────────────
 *
 * All three pay a PERCENTAGE OF A BASIS, accumulated over a CYCLE, paid out
 * some time after that cycle closes:
 *
 *   CASHBACK   basis = the player's net LOSS over the cycle
 *   MANUAL     basis = the same loss, but the cycle starts when the player
 *              takes the promotion rather than at a fixed clock time, and it
 *              can ALSO carry an ordinary deposit bonus (the existing
 *              amount-setting columns keep doing that job)
 *   REBATE     basis = TURNOVER wagered over the cycle, win or lose
 *
 * ── The cycle ────────────────────────────────────────────────────────────
 *
 * Length is stored as a DURATION, not as a start/end pair, because the admin
 * thinks in "a 7 day cycle" / "a 12 hour cycle" and keeping two dates the
 * right distance apart by hand is what makes a repeating cycle drift.
 * `cycle_length_unit` is presentation only — DAYS for cashback and rebate,
 * HOURS for manual — while `cycle_length_minutes` is what arithmetic uses.
 *
 *   cycle_start_mode = FIXED     one shared cycle, starting at cycle_start_at
 *                    = ON_CLAIM  a private cycle per player, starting when
 *                                they take the promotion. A fixed payout
 *                                clock cannot work here: every player's
 *                                cycle ends at a different moment.
 *
 * Payout is therefore always an OFFSET from the cycle's end
 * (`payout_delay_minutes`), never an absolute timestamp. With `cycle_repeat`
 * on, the next cycle begins the minute the last one ended and the same
 * length applies, so the window never drifts.
 *
 * ── Eligibility ──────────────────────────────────────────────────────────
 *
 * Four independent checks run just before payout, each switchable:
 *
 *   check_min_deposit      did they deposit enough during the cycle
 *   check_wallet_balance   money still sitting in the wallet counts against
 *                          the loss — a player holding a balance has not
 *                          really lost it
 *   check_withdrawal       withdrawals count against it for the same reason
 *   check_bonus_amount     bonus credited is NOT the player's own money, so
 *                          it is excluded from the deposits side
 *
 * The loss is therefore, over the cycle:
 *
 *   real_deposits = deposits − bonus_credited
 *   player_net    = withdrawals + closing_balance − real_deposits
 *   eligible_loss = player_net < 0 ? −player_net : 0
 *
 * A player in profit has lost nothing and is paid nothing.
 *
 * `cashback_min_deposit` is the MANUAL case only, where the minimum gates
 * access to the promotion at deposit time rather than being checked later.
 *
 * ── Tiers ────────────────────────────────────────────────────────────────
 *
 * `promotion_cashback_tiers` holds BANDS, ordered by tier_no. A band runs
 * from the previous band's upper bound to its own, the first starting at
 * zero, and the last may be unbounded (upper_amount NULL):
 *
 *   tier 1  upper 999   5%     a 0–999 basis pays 5%
 *   tier 2  upper 1999  10%    a 1000–1999 basis pays 10%
 *   tier 3  upper NULL  15%    anything above pays 15%
 *
 * The percentage applies to the ACTUAL basis, not to the band's bound: a
 * ৳200 loss in the first band pays 5% of ৳200.
 *
 * `min_payout` / `max_payout` clamp the result — below the minimum nothing
 * is paid at all, and a max of 0/NULL means uncapped. `cashback_multiplier`
 * is the turnover attached to whatever is paid (bonus × multiplier).
 *
 * ── Runs and payouts ─────────────────────────────────────────────────────
 *
 * `promotion_cashback_runs` is one row per cycle — shared when FIXED,
 * per-player when ON_CLAIM — and `promotion_cashback_payouts` one row per
 * player per run, INCLUDING those paid nothing, with the reason. A player
 * asking "why did I get no cashback this week" is the support question this
 * feature creates, and it has to be answerable without replaying the maths.
 *
 * Idempotent.
 */
export class CashbackRebatePromotions2390000000000
  implements MigrationInterface
{
  name = 'CashbackRebatePromotions2390000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── Promotion-level configuration ───────────────────────────────────
    await q.query(`
      ALTER TABLE public.promotions
        ADD COLUMN IF NOT EXISTS cashback_basis        VARCHAR(16),
        ADD COLUMN IF NOT EXISTS cycle_start_mode      VARCHAR(16),
        ADD COLUMN IF NOT EXISTS cycle_start_at        TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS cycle_length_minutes  INTEGER,
        ADD COLUMN IF NOT EXISTS cycle_length_unit     VARCHAR(8),
        ADD COLUMN IF NOT EXISTS cycle_repeat          BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS payout_delay_minutes  INTEGER,
        ADD COLUMN IF NOT EXISTS check_min_deposit     BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS check_wallet_balance  BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS check_withdrawal      BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS check_bonus_amount    BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS cashback_min_deposit  NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS min_payout            NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS max_payout            NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS cashback_multiplier   NUMERIC(10,2);
    `);

    await q.query(`
      ALTER TABLE public.promotions
        DROP CONSTRAINT IF EXISTS promotions_cashback_basis_check;
      ALTER TABLE public.promotions
        ADD CONSTRAINT promotions_cashback_basis_check
        CHECK (cashback_basis IS NULL OR cashback_basis IN ('LOSS', 'TURNOVER'));
    `);

    await q.query(`
      ALTER TABLE public.promotions
        DROP CONSTRAINT IF EXISTS promotions_cycle_start_mode_check;
      ALTER TABLE public.promotions
        ADD CONSTRAINT promotions_cycle_start_mode_check
        CHECK (cycle_start_mode IS NULL OR cycle_start_mode IN ('FIXED', 'ON_CLAIM'));
    `);

    // ── Tiers ───────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.promotion_cashback_tiers (
        id            BIGSERIAL PRIMARY KEY,
        promotion_id  BIGINT        NOT NULL,
        tier_no       INTEGER       NOT NULL,
        -- Top of the band. NULL = unbounded, allowed on the last tier only.
        upper_amount  NUMERIC(18,2),
        percent       NUMERIC(6,3)  NOT NULL,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT promotion_cashback_tiers_promo_fk FOREIGN KEY (promotion_id)
          REFERENCES public.promotions(id) ON DELETE CASCADE,
        CONSTRAINT promotion_cashback_tiers_percent_check
          CHECK (percent >= 0 AND percent <= 100)
      );
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cashback_tier_order
        ON public.promotion_cashback_tiers (promotion_id, tier_no);
    `);

    // ── Cycles ──────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.promotion_cashback_runs (
        id            BIGSERIAL PRIMARY KEY,
        promotion_id  BIGINT       NOT NULL,
        -- NULL for a FIXED shared cycle; set for a per-player ON_CLAIM one.
        user_id       BIGINT,
        cycle_start   TIMESTAMPTZ  NOT NULL,
        cycle_end     TIMESTAMPTZ  NOT NULL,
        payout_at     TIMESTAMPTZ  NOT NULL,
        status        VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
        settled_at    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT promotion_cashback_runs_promo_fk FOREIGN KEY (promotion_id)
          REFERENCES public.promotions(id) ON DELETE CASCADE,
        CONSTRAINT promotion_cashback_runs_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT promotion_cashback_runs_status_check
          CHECK (status IN ('OPEN', 'PENDING_PAYOUT', 'SETTLED', 'CANCELLED'))
      );
    `);
    // The watcher's only question: which cycles are due?
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_cashback_runs_due
        ON public.promotion_cashback_runs (payout_at)
        WHERE status IN ('OPEN', 'PENDING_PAYOUT');
    `);
    // One open cycle per player per promotion, and one shared open cycle for
    // a FIXED promotion. Partial, because a settled cycle must not block the
    // next one from opening.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cashback_run_open
        ON public.promotion_cashback_runs
           (promotion_id, COALESCE(user_id, 0))
        WHERE status IN ('OPEN', 'PENDING_PAYOUT');
    `);

    // ── Per-player outcome ──────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.promotion_cashback_payouts (
        id              BIGSERIAL PRIMARY KEY,
        run_id          BIGINT        NOT NULL,
        user_id         BIGINT        NOT NULL,
        -- The loss or turnover the percentage was applied to.
        basis_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
        tier_no         INTEGER,
        tier_percent    NUMERIC(6,3),
        -- Before the min/max clamp, so a clamped payout stays explainable.
        gross_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
        paid_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
        status          VARCHAR(16)   NOT NULL DEFAULT 'PENDING',
        -- Why nothing was paid: IN_PROFIT, BELOW_MIN_PAYOUT,
        -- MIN_DEPOSIT_NOT_MET, NO_TIER_MATCHED...
        skip_reason     VARCHAR(40),
        turnover_requirement_id BIGINT,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT promotion_cashback_payouts_run_fk FOREIGN KEY (run_id)
          REFERENCES public.promotion_cashback_runs(id) ON DELETE CASCADE,
        CONSTRAINT promotion_cashback_payouts_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT promotion_cashback_payouts_status_check
          CHECK (status IN ('PENDING', 'PAID', 'SKIPPED', 'FAILED'))
      );
    `);
    // A player is paid at most once per cycle, however often the watcher runs.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cashback_payout_once
        ON public.promotion_cashback_payouts (run_id, user_id);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_cashback_payouts_user
        ON public.promotion_cashback_payouts (user_id, created_at DESC);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS public.promotion_cashback_payouts;`);
    await q.query(`DROP TABLE IF EXISTS public.promotion_cashback_runs;`);
    await q.query(`DROP TABLE IF EXISTS public.promotion_cashback_tiers;`);
    await q.query(`
      ALTER TABLE public.promotions
        DROP CONSTRAINT IF EXISTS promotions_cycle_start_mode_check,
        DROP CONSTRAINT IF EXISTS promotions_cashback_basis_check,
        DROP COLUMN IF EXISTS cashback_multiplier,
        DROP COLUMN IF EXISTS max_payout,
        DROP COLUMN IF EXISTS min_payout,
        DROP COLUMN IF EXISTS cashback_min_deposit,
        DROP COLUMN IF EXISTS check_bonus_amount,
        DROP COLUMN IF EXISTS check_withdrawal,
        DROP COLUMN IF EXISTS check_wallet_balance,
        DROP COLUMN IF EXISTS check_min_deposit,
        DROP COLUMN IF EXISTS payout_delay_minutes,
        DROP COLUMN IF EXISTS cycle_repeat,
        DROP COLUMN IF EXISTS cycle_length_unit,
        DROP COLUMN IF EXISTS cycle_length_minutes,
        DROP COLUMN IF EXISTS cycle_start_at,
        DROP COLUMN IF EXISTS cycle_start_mode,
        DROP COLUMN IF EXISTS cashback_basis;
    `);
  }
}

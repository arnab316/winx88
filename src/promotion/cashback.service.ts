import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, QueryRunner } from 'typeorm';
import { TurnoverService } from '../turnover/turnover.service';
import {
  computeLossBasis,
  computeCashback,
  currentWindow,
  nextCycle,
  type CashbackTier,
} from './cashback-math';

/**
 * Cashback, Rebate and Manual promotions: the cycle lifecycle and the payout.
 *
 * A cycle is a window over which a basis accumulates — the player's net LOSS
 * for cashback and manual, the TURNOVER they wagered for rebate — followed by
 * a payout some fixed time after it closes.
 *
 *   FIXED     one shared window per promotion, on the admin's clock
 *   ON_CLAIM  a private window per player, opening when they take it
 *
 * Two things run on a timer: windows whose payout moment has arrived are
 * settled, and a repeating promotion's next window is opened the instant the
 * last one closed. Both are idempotent — the unique indexes on
 * promotion_cashback_runs and promotion_cashback_payouts mean a double tick,
 * a restart mid-run, or two instances racing cannot pay anyone twice.
 */
@Injectable()
export class CashbackService {
  private readonly logger = new Logger(CashbackService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly turnover: TurnoverService,
  ) {}

  private static readonly MIN = 60_000;

  // ═════════════════════════════════════════════════════════════
  // CYCLE LIFECYCLE
  // ═════════════════════════════════════════════════════════════

  /** Promotions configured with a cycle and currently live. */
  private async cyclePromotions(startMode?: 'FIXED' | 'ON_CLAIM') {
    return this.dataSource.query(
      `SELECT id, title, kind, cashback_basis, cycle_start_mode,
              cycle_start_at, cycle_length_minutes, cycle_repeat,
              payout_delay_minutes, check_min_deposit, check_wallet_balance,
              check_withdrawal, check_bonus_amount, cashback_min_deposit,
              min_payout, max_payout, cashback_multiplier,
              eligible_game_categories, eligible_providers
         FROM promotions
        WHERE is_active = TRUE
          AND cashback_basis IS NOT NULL
          AND cycle_length_minutes > 0
          ${startMode ? `AND cycle_start_mode = '${startMode}'` : ''}`,
    );
  }

  /**
   * Make sure every FIXED promotion has its current window open.
   *
   * The window is derived by stepping forward from the configured start in
   * whole cycle lengths until it contains "now", rather than counting from
   * the last run. A promotion created weeks ago, or one whose watcher was
   * down over a weekend, therefore lands on the window it should be in
   * instead of replaying every window it missed.
   */
  async openDueCycles(now = new Date()): Promise<number> {
    const promos = await this.cyclePromotions('FIXED');
    let opened = 0;

    for (const p of promos) {
      const start = p.cycle_start_at ? new Date(p.cycle_start_at) : null;
      if (!start || start.getTime() > now.getTime()) continue;

      const window = currentWindow({
        start,
        lengthMinutes: Number(p.cycle_length_minutes),
        repeat: !!p.cycle_repeat,
        now,
      });
      if (!window) continue;
      const { cycleStart, cycleEnd } = window;

      const payoutAt = new Date(
        cycleEnd.getTime() +
          Number(p.payout_delay_minutes ?? 0) * CashbackService.MIN,
      );

      // ON CONFLICT DO NOTHING against uq_cashback_run_open: whichever
      // instance gets there first opens it, the rest are no-ops.
      const res = await this.dataSource.query(
        `INSERT INTO promotion_cashback_runs
           (promotion_id, user_id, cycle_start, cycle_end, payout_at, status)
         VALUES ($1, NULL, $2, $3, $4, 'OPEN')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [p.id, cycleStart, cycleEnd, payoutAt],
      );
      if (res.length) opened++;
    }
    return opened;
  }

  /**
   * Open a player's private window when they claim an ON_CLAIM promotion.
   *
   * Called from the promotion engine at grant time. Silent when the
   * promotion has no cycle, so the engine can call it unconditionally.
   */
  async onPromotionClaimed(
    userId: number,
    promotionId: number,
    at = new Date(),
  ): Promise<void> {
    const [p] = await this.dataSource.query(
      `SELECT id, cycle_start_mode, cycle_length_minutes, payout_delay_minutes
         FROM promotions
        WHERE id = $1 AND cashback_basis IS NOT NULL
          AND cycle_start_mode = 'ON_CLAIM' AND cycle_length_minutes > 0`,
      [promotionId],
    );
    if (!p) return;

    const cycleEnd = new Date(
      at.getTime() + Number(p.cycle_length_minutes) * CashbackService.MIN,
    );
    const payoutAt = new Date(
      cycleEnd.getTime() +
        Number(p.payout_delay_minutes ?? 0) * CashbackService.MIN,
    );

    await this.dataSource.query(
      `INSERT INTO promotion_cashback_runs
         (promotion_id, user_id, cycle_start, cycle_end, payout_at, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN')
       ON CONFLICT DO NOTHING`,
      [promotionId, userId, at, cycleEnd, payoutAt],
    );
  }

  // ═════════════════════════════════════════════════════════════
  // THE BASIS
  // ═════════════════════════════════════════════════════════════

  /**
   * Money in and out per player over a window.
   *
   * Only players with activity in the window are returned — a shared cycle
   * must not walk every account on the platform to discover that most of
   * them did nothing.
   */
  private async lossInputs(
    from: Date,
    to: Date,
    userId: number | null,
  ): Promise<
    Map<number, { deposits: number; bonus: number; withdrawals: number }>
  > {
    const rows = await this.dataSource.query(
      `SELECT u AS user_id,
              SUM(dep)  AS deposits,
              SUM(bon)  AS bonus,
              SUM(wd)   AS withdrawals
         FROM (
           SELECT d.user_id AS u, d.amount AS dep, 0 AS bon, 0 AS wd
             FROM deposits d
            WHERE d.status = 'APPROVED' AND NOT d.is_test
              AND d.decided_at >= $1 AND d.decided_at < $2
           UNION ALL
           SELECT c.user_id, 0, c.bonus_amount, 0
             FROM user_promotion_claims c
            WHERE c.status IN ('ACTIVE','COMPLETED')
              AND c.claimed_at >= $1 AND c.claimed_at < $2
           UNION ALL
           SELECT w.user_id, 0, 0, w.amount
             FROM withdrawals w
            WHERE w.status = 'APPROVED'
              AND w.decided_at >= $1 AND w.decided_at < $2
         ) t
        WHERE ($3::bigint IS NULL OR u = $3::bigint)
        GROUP BY u`,
      [from, to, userId],
    );

    const out = new Map<
      number,
      { deposits: number; bonus: number; withdrawals: number }
    >();
    for (const r of rows) {
      out.set(Number(r.user_id), {
        deposits: Number(r.deposits ?? 0),
        bonus: Number(r.bonus ?? 0),
        withdrawals: Number(r.withdrawals ?? 0),
      });
    }
    return out;
  }

  /**
   * Stake wagered per player over a window, across every integration.
   *
   * Rebate pays on turnover, and turnover means money staked — not the
   * turnover_ledger, which only records progress against an ACTIVE bonus
   * requirement and would read zero for any player without one.
   */
  private async turnoverInputs(
    from: Date,
    to: Date,
    userId: number | null,
    rules: { categories: string[]; providers: string[] },
  ): Promise<Map<number, number>> {
    // Empty means unrestricted, exactly as the turnover engine reads them.
    const cats = rules.categories.length ? rules.categories : null;
    const provs = rules.providers.length ? rules.providers : null;

    const rows = await this.dataSource.query(
      `SELECT u AS user_id, SUM(stake) AS staked
         FROM (
           SELECT b.user_id AS u, b.bet_amount AS stake,
                  'LOTTERY'::text AS cat, 'OWN:HOUSE'::text AS prov
             FROM bets b
            WHERE b.result_status <> 'CANCELLED'
              AND b.placed_at >= $1 AND b.placed_at < $2
           UNION ALL
           SELECT st.user_id, st.amount, 'SLOT',
                  'PALACE:' || COALESCE(st.provider_id::text, '')
             FROM slot_transactions st
            WHERE st.type = 'bet' AND NOT st.is_cancelled
              AND st.created_at >= $1 AND st.created_at < $2
           UNION ALL
           SELECT ot.user_id, -ot.amount,
                  CASE WHEN ot.vendor_code LIKE 'fishing-%' THEN 'FISH'
                       WHEN ot.vendor_code LIKE 'mini-%'    THEN 'CRASH'
                       ELSE 'LIVE' END,
                  'OROPLAY:' || UPPER(COALESCE(ot.vendor_code, ''))
             FROM oroplay_transactions ot
            WHERE ot.amount < 0 AND NOT ot.is_canceled
              AND ot.created_at >= $1 AND ot.created_at < $2
           UNION ALL
           SELECT nt.user_id, nt.bet_money,
                  CASE nt.game_type
                    WHEN 'slot' THEN 'SLOT' WHEN 'live' THEN 'LIVE'
                    WHEN 'SB'   THEN 'SPORTS' WHEN 'MN' THEN 'CRASH'
                    WHEN 'FH'   THEN 'FISH'  ELSE 'OTHER' END,
                  'NEXUS:' || UPPER(COALESCE(nt.provider_code, ''))
             FROM nexus_transactions nt
            WHERE nt.bet_money > 0 AND NOT nt.is_canceled
              AND nt.created_at >= $1 AND nt.created_at < $2
           UNION ALL
           SELECT sb.user_id, sb.amount, 'SPORTS', 'SPORTS:HOUSE'
             FROM sports_bet_logs sb
            WHERE sb.user_id IS NOT NULL
              AND (sb.type IS NULL OR sb.type NOT IN ('3','6','7','8'))
              AND sb.created_at >= $1 AND sb.created_at < $2
         ) t
        WHERE ($3::bigint IS NULL OR u = $3::bigint)
          -- Same rules the bonus form sets and the turnover engine honours,
          -- so a rebate "on slots only" cannot quietly pay on live play.
          AND ($4::text[] IS NULL OR cat  = ANY($4::text[]))
          AND ($5::text[] IS NULL OR prov = ANY($5::text[]))
        GROUP BY u`,
      [from, to, userId, cats, provs],
    );

    const out = new Map<number, number>();
    for (const r of rows) out.set(Number(r.user_id), Number(r.staked ?? 0));
    return out;
  }

  /** A promotion's game rules, upper-cased the way the keys are stored. */
  private rulesOf(row: any): { categories: string[]; providers: string[] } {
    const list = (raw: unknown) =>
      (Array.isArray(raw) ? raw : [])
        .map((v) => String(v ?? '').trim().toUpperCase())
        .filter(Boolean);
    return {
      categories: list(row.eligible_game_categories),
      providers: list(row.eligible_providers),
    };
  }

  /** Current wallet balances for a set of players. */
  private async balances(userIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!userIds.length) return out;
    const rows = await this.dataSource.query(
      `SELECT user_id, balance FROM wallets WHERE user_id = ANY($1::bigint[])`,
      [userIds],
    );
    for (const r of rows) out.set(Number(r.user_id), Number(r.balance ?? 0));
    return out;
  }

  // ═════════════════════════════════════════════════════════════
  // SETTLEMENT
  // ═════════════════════════════════════════════════════════════

  /**
   * Pay out every window whose payout moment has passed, then open the next
   * one where the promotion repeats.
   */
  async settleDueCycles(now = new Date()): Promise<{
    runs: number;
    paid: number;
    skipped: number;
  }> {
    const due = await this.dataSource.query(
      `SELECT r.*, p.cashback_basis, p.cycle_repeat, p.cycle_length_minutes,
              p.payout_delay_minutes, p.check_min_deposit,
              p.check_wallet_balance, p.check_withdrawal,
              p.check_bonus_amount, p.cashback_min_deposit,
              p.min_payout, p.max_payout, p.cashback_multiplier, p.title,
              p.eligible_game_categories, p.eligible_providers
         FROM promotion_cashback_runs r
         JOIN promotions p ON p.id = r.promotion_id
        WHERE r.status IN ('OPEN','PENDING_PAYOUT')
          AND r.payout_at <= $1
        ORDER BY r.payout_at
        LIMIT 200`,
      [now],
    );

    let paid = 0;
    let skipped = 0;

    for (const run of due) {
      try {
        const res = await this.settleRun(run);
        paid += res.paid;
        skipped += res.skipped;
      } catch (e: any) {
        this.logger.error(
          `cashback run ${run.id} (${run.title}) failed: ${e.message}`,
        );
      }
    }

    // Opening the next window is separate from settling, so a promotion
    // whose settlement failed still gets its next cycle and does not stall.
    await this.openDueCycles(now);

    return { runs: due.length, paid, skipped };
  }

  private async settleRun(run: any): Promise<{ paid: number; skipped: number }> {
    const from = new Date(run.cycle_start);
    const to = new Date(run.cycle_end);
    const userId = run.user_id ? Number(run.user_id) : null;

    const tiers: CashbackTier[] = (
      await this.dataSource.query(
        `SELECT tier_no, upper_amount, percent
           FROM promotion_cashback_tiers
          WHERE promotion_id = $1 ORDER BY tier_no`,
        [run.promotion_id],
      )
    ).map((t: any) => ({
      tierNo: Number(t.tier_no),
      upperAmount: t.upper_amount === null ? null : Number(t.upper_amount),
      percent: Number(t.percent),
    }));

    const isTurnover = run.cashback_basis === 'TURNOVER';
    const money = await this.lossInputs(from, to, userId);
    const staked = isTurnover
      ? await this.turnoverInputs(from, to, userId, this.rulesOf(run))
      : new Map<number, number>();

    const participants = new Set<number>([
      ...money.keys(),
      ...staked.keys(),
    ]);
    const wallets = run.check_wallet_balance
      ? await this.balances([...participants])
      : new Map<number, number>();

    let paid = 0;
    let skipped = 0;

    for (const uid of participants) {
      const m = money.get(uid) ?? { deposits: 0, bonus: 0, withdrawals: 0 };

      // The minimum-deposit gate is a pass/fail on the window, separate
      // from the basis it would otherwise contribute to.
      if (
        run.check_min_deposit &&
        Number(run.cashback_min_deposit ?? 0) > 0 &&
        m.deposits < Number(run.cashback_min_deposit)
      ) {
        await this.record(run.id, uid, {
          basisAmount: 0, tierNo: null, tierPercent: null,
          grossAmount: 0, paidAmount: 0, skipReason: 'MIN_DEPOSIT_NOT_MET',
        });
        skipped++;
        continue;
      }

      const basis = isTurnover
        ? (staked.get(uid) ?? 0)
        : computeLossBasis({
            deposits: m.deposits,
            bonusCredited: m.bonus,
            withdrawals: m.withdrawals,
            closingBalance: wallets.get(uid) ?? 0,
            countBonus: !!run.check_bonus_amount,
            countWithdrawals: !!run.check_withdrawal,
            countWalletBalance: !!run.check_wallet_balance,
          });

      const outcome = computeCashback(basis, {
        tiers,
        minPayout: run.min_payout === null ? null : Number(run.min_payout),
        maxPayout: run.max_payout === null ? null : Number(run.max_payout),
      });

      if (outcome.paidAmount > 0) {
        await this.payOut(run, uid, outcome);
        paid++;
      } else {
        await this.record(run.id, uid, outcome);
        skipped++;
      }
    }

    await this.dataSource.query(
      `UPDATE promotion_cashback_runs
          SET status = 'SETTLED', settled_at = NOW()
        WHERE id = $1`,
      [run.id],
    );

    this.logger.log(
      `cashback run ${run.id} (${run.title}) settled: ${paid} paid, ${skipped} skipped`,
    );
    return { paid, skipped };
  }

  /** A player who earned nothing, and why. */
  private async record(runId: number, userId: number, o: any): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO promotion_cashback_payouts
         (run_id, user_id, basis_amount, tier_no, tier_percent,
          gross_amount, paid_amount, status, skip_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'SKIPPED',$8)
       ON CONFLICT (run_id, user_id) DO NOTHING`,
      [
        runId, userId, o.basisAmount, o.tierNo, o.tierPercent,
        o.grossAmount, 0, o.skipReason,
      ],
    );
  }

  /**
   * Credit a player and attach the turnover the promotion asks for.
   *
   * The payout row is inserted FIRST, inside the same transaction: its
   * unique (run_id, user_id) index is what makes paying twice impossible,
   * so it has to be the thing that fails rather than an afterthought
   * written once the money has already moved.
   */
  private async payOut(run: any, userId: number, o: any): Promise<void> {
    const qr: QueryRunner = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const inserted = await qr.query(
        `INSERT INTO promotion_cashback_payouts
           (run_id, user_id, basis_amount, tier_no, tier_percent,
            gross_amount, paid_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')
         ON CONFLICT (run_id, user_id) DO NOTHING
         RETURNING id`,
        [
          run.id, userId, o.basisAmount, o.tierNo, o.tierPercent,
          o.grossAmount, o.paidAmount,
        ],
      );
      // Already paid on an earlier tick — leave it alone.
      if (!inserted.length) {
        await qr.rollbackTransaction();
        return;
      }
      const payoutId = Number(inserted[0].id);

      const [w] = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (!w) throw new Error(`no wallet for user ${userId}`);

      const before = Number(w.balance);
      const after = Math.round((before + o.paidAmount) * 100) / 100;
      await qr.query(
        `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2`,
        [after, userId],
      );

      const multiplier = Number(run.cashback_multiplier ?? 0);
      let requirementId: number | null = null;
      if (multiplier > 0) {
        const req = await this.turnover.insertRequirement(qr, {
          userId,
          sourceType: 'BONUS',
          sourceId: run.promotion_id,
          baseAmount: o.paidAmount,
          multiplier,
          targetAmount: o.paidAmount * multiplier,
          label: run.title,
        });
        requirementId = req.requirementId;
      }

      await qr.query(
        `UPDATE promotion_cashback_payouts
            SET status = 'PAID', turnover_requirement_id = $1
          WHERE id = $2`,
        [requirementId, payoutId],
      );

      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN READS
  // ═════════════════════════════════════════════════════════════

  /**
   * Cycles for a promotion, newest first, each with what it paid.
   *
   * The counts come from the payout rows rather than being recomputed, so
   * the figures an admin sees are the ones that were actually written.
   */
  async listRuns(promotionId: number, limit = 50) {
    return this.dataSource.query(
      `SELECT r.id, r.user_id, u.username, r.cycle_start, r.cycle_end,
              r.payout_at, r.status, r.settled_at,
              COUNT(po.id) FILTER (WHERE po.status = 'PAID')::int    AS paid_count,
              COUNT(po.id) FILTER (WHERE po.status = 'SKIPPED')::int AS skipped_count,
              COALESCE(SUM(po.paid_amount), 0)                       AS total_paid
         FROM promotion_cashback_runs r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN promotion_cashback_payouts po ON po.run_id = r.id
        WHERE r.promotion_id = $1
        GROUP BY r.id, u.username
        ORDER BY r.cycle_start DESC
        LIMIT $2`,
      [promotionId, Math.min(Math.max(limit, 1), 200)],
    );
  }

  /**
   * Who got what in one cycle, INCLUDING those paid nothing.
   *
   * The skipped rows are the point: "why did I get no cashback" is the
   * question this feature creates, and `skip_reason` answers it without
   * anyone re-deriving the maths.
   */
  async listPayouts(runId: number, page = 1, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;

    const [rows, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT po.id, po.user_id, u.username, po.basis_amount, po.tier_no,
                po.tier_percent, po.gross_amount, po.paid_amount, po.status,
                po.skip_reason, po.turnover_requirement_id, po.created_at
           FROM promotion_cashback_payouts po
           JOIN users u ON u.id = po.user_id
          WHERE po.run_id = $1
          ORDER BY po.paid_amount DESC, po.id
          LIMIT $2 OFFSET $3`,
        [runId, take, skip],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total
           FROM promotion_cashback_payouts WHERE run_id = $1`,
        [runId],
      ),
    ]);

    return { total, page: Math.max(page, 1), limit: take, data: rows };
  }

  /**
   * Settle now, without waiting for the watcher.
   *
   * Safe to invoke repeatedly: settlement is guarded by the unique
   * (run_id, user_id) index, so a second call pays nobody twice.
   */
  async settleNow(): Promise<{ runs: number; paid: number; skipped: number }> {
    return this.settleDueCycles();
  }

  /**
   * A player's own cashback history, settled cycles and the one in flight.
   *
   * Skipped cycles are included on purpose, with the reason spelled out.
   * "Why did I get nothing this week" is the question this feature creates,
   * and leaving it to support to answer by hand is how a cashback promotion
   * turns into a complaints queue.
   */
  async myCashback(userId: number, limit = 20) {
    const settled = await this.dataSource.query(
      `SELECT po.id, p.title, p.kind, p.cashback_basis AS basis,
              r.cycle_start, r.cycle_end, r.payout_at,
              po.basis_amount, po.tier_percent, po.paid_amount,
              po.status, po.skip_reason
         FROM promotion_cashback_payouts po
         JOIN promotion_cashback_runs r ON r.id = po.run_id
         JOIN promotions p ON p.id = r.promotion_id
        WHERE po.user_id = $1
        ORDER BY r.cycle_end DESC
        LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 100)],
    );

    // The window still counting — shown without an amount, because the
    // basis is not final until it closes and a figure that moves would
    // read as a promise.
    const open = await this.dataSource.query(
      `SELECT r.id, p.title, p.kind, p.cashback_basis AS basis,
              r.cycle_start, r.cycle_end, r.payout_at
         FROM promotion_cashback_runs r
         JOIN promotions p ON p.id = r.promotion_id
        WHERE r.status IN ('OPEN','PENDING_PAYOUT')
          AND (r.user_id = $1 OR r.user_id IS NULL)
        ORDER BY r.cycle_end`,
      [userId],
    );

    const reasons: Record<string, string> = {
      IN_PROFIT: 'You finished the period in profit, so there was no loss to pay back.',
      NO_BASIS: 'There was nothing to calculate on for this period.',
      NO_TIER_MATCHED: 'The amount fell outside every reward tier.',
      BELOW_MIN_PAYOUT: 'The amount earned was below the minimum payout.',
      MIN_DEPOSIT_NOT_MET: 'Your deposits for this period were below the minimum.',
    };

    return {
      inProgress: open,
      history: settled.map((r: any) => ({
        ...r,
        explanation: r.skip_reason ? (reasons[r.skip_reason] ?? null) : null,
      })),
    };
  }

  // ═════════════════════════════════════════════════════════════
  // WATCHER
  // ═════════════════════════════════════════════════════════════

  /**
   * Every ten minutes rather than on the minute: a payout moment is set in
   * hours, so this is plenty prompt, and it keeps the five-table turnover
   * scan off the database on a tight loop.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async cycleCron(): Promise<void> {
    try {
      const res = await this.settleDueCycles();
      if (res.runs) {
        this.logger.log(
          `cashback: ${res.runs} run(s), ${res.paid} paid, ${res.skipped} skipped`,
        );
      }
    } catch (e: any) {
      this.logger.error(`cashback cron failed: ${e.message}`);
    }
  }

  /** Unused for now, kept so `nextCycle` has one caller. */
  previewNextCycle = nextCycle;
}

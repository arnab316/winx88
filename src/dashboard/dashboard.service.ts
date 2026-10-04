import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type DashboardRange = 'today' | '7d' | '30d';

const RANGE_DAYS: Record<DashboardRange, number> = { today: 1, '7d': 7, '30d': 30 };

// Business day boundaries. "Today" means today in Dhaka, not in UTC — a UTC
// day would split the evening peak across two dashboard days.
const TZ = 'Asia/Dhaka';

type Period = { start: Date; end: Date; prevStart: Date; prevEnd: Date };

/**
 * Super-admin dashboard: one call returns every card on the page.
 *
 * Every figure is compared against the SAME elapsed stretch of the previous
 * period — "today so far" vs "yesterday up to this time", "last 7 days" vs the
 * 7 days before — so a dashboard opened at 10am doesn't show a fake -60%.
 *
 * Wagering reads the same six sources as the unified game-history feed
 * (game-history.service.ts), but platform-wide and summed per ledger row
 * rather than collapsed per round: turnover and GGR are sums, so collapsing
 * would only cost time. Only the big-wins list collapses per round, because a
 * "win" is a round-level idea.
 *
 *   turnover = valid (non-cancelled) stake
 *   GGR      = turnover − payouts
 */
@Injectable()
export class DashboardService {
  constructor(private readonly dataSource: DataSource) {}

  async getDashboard(opts: { range?: string; bigWinMultiplier?: number; bigWinMin?: number }) {
    const range = (opts.range ?? 'today').toLowerCase() as DashboardRange;
    if (!RANGE_DAYS[range]) {
      throw new BadRequestException(`range must be one of: ${Object.keys(RANGE_DAYS).join(', ')}`);
    }
    const unit = range === 'today' ? 'hour' : 'day';
    const period = await this.period(RANGE_DAYS[range]);

    const [buckets, wagers, cash, pending, pendingDeposits, bigWins, spin] = await Promise.all([
      this.buckets(period.start, unit),
      this.wagerAggregates(period, unit),
      this.cashAggregates(period, unit),
      this.pendingQueues(),
      this.latestPendingDeposits(),
      this.bigWins(period, opts.bigWinMultiplier ?? 10, opts.bigWinMin ?? 1000),
      this.spinKpis(period, unit),
    ]);

    const cur = (kind: string) => cash.totals[`${kind}:cur`] ?? { count: 0, amount: 0 };
    const prev = (kind: string) => cash.totals[`${kind}:prev`] ?? { count: 0, amount: 0 };
    const bonusCur = ['BONUS_PROMOTION', 'BONUS_REFERRAL', 'BONUS_SPIN']
      .reduce((s, k) => s + cur(k).amount, 0);
    const bonusPrev = ['BONUS_PROMOTION', 'BONUS_REFERRAL', 'BONUS_SPIN']
      .reduce((s, k) => s + prev(k).amount, 0);
    const netCur = cur('DEPOSIT').amount - cur('WITHDRAWAL').amount;
    const netPrev = prev('DEPOSIT').amount - prev('WITHDRAWAL').amount;

    const turnoverTotal = wagers.total.cur.turnover;

    return {
      range,
      timezone: TZ,
      bucketUnit: unit,
      period,
      generatedAt: new Date(),
      pending,
      kpis: {
        deposits: this.kpi(cur('DEPOSIT').amount, prev('DEPOSIT').amount, { count: cur('DEPOSIT').count }),
        withdrawals: this.kpi(cur('WITHDRAWAL').amount, prev('WITHDRAWAL').amount, { count: cur('WITHDRAWAL').count }),
        netCashflow: this.kpi(netCur, netPrev),
        ggr: this.kpi(wagers.total.cur.ggr, wagers.total.prev.ggr, { payout: wagers.total.cur.payout }),
        turnover: this.kpi(turnoverTotal, wagers.total.prev.turnover),
        registrations: this.kpi(cur('REGISTRATION').count, prev('REGISTRATION').count),
        // Players who placed at least one bet. Logins are reported alongside
        // but not compared: users.last_login_at keeps only the latest login,
        // so a previous-period login count cannot be reconstructed.
        activePlayers: this.kpi(wagers.total.cur.players, wagers.total.prev.players, {
          loggedIn: cash.loggedIn,
        }),
        bonusPaid: this.kpi(bonusCur, bonusPrev, {
          breakdown: {
            promotion: cur('BONUS_PROMOTION').amount,
            referral: cur('BONUS_REFERRAL').amount,
            spin: cur('BONUS_SPIN').amount,
          },
        }),
      },
      series: buckets.map((b) => {
        const c = cash.series[b] ?? {};
        const w = wagers.series[b] ?? { turnover: 0, payout: 0, players: 0 };
        return {
          bucket: b,
          deposits: c.DEPOSIT ?? 0,
          withdrawals: c.WITHDRAWAL ?? 0,
          registrations: c.REGISTRATION_COUNT ?? 0,
          bonus: (c.BONUS_PROMOTION ?? 0) + (c.BONUS_REFERRAL ?? 0) + (c.BONUS_SPIN ?? 0),
          turnover: w.turnover,
          ggr: this.r2(w.turnover - w.payout),
          activePlayers: w.players,
          spins: spin.seriesByBucket[b]?.spins ?? 0,
          spinPaid: spin.seriesByBucket[b]?.paid ?? 0,
        };
      }),
      turnoverByCategory: wagers.byCategory
        .map((c) => ({
          ...c,
          sharePct: turnoverTotal > 0 ? this.r2((c.turnover / turnoverTotal) * 100) : 0,
        }))
        .sort((a, b) => b.turnover - a.turnover),
      pendingDeposits,
      bigWins,
      spin: (({ seriesByBucket: _omit, ...rest }) => rest)(spin),
    };
  }

  // ── helpers ──────────────────────────────────────────────────────

  private r2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  /** changePct is null when there is no base to compare against (prev = 0). */
  private kpi(value: number, prev: number, extra: Record<string, unknown> = {}) {
    const changePct = prev === 0 ? (value === 0 ? 0 : null) : this.r2(((value - prev) / Math.abs(prev)) * 100);
    return { value: this.r2(value), prev: this.r2(prev), changePct, ...extra };
  }

  private async period(days: number): Promise<Period> {
    const [row] = await this.dataSource.query(
      `SELECT s                                   AS start,
              now()                               AS "end",
              s     - ($2::int * INTERVAL '1 day') AS prev_start,
              now() - ($2::int * INTERVAL '1 day') AS prev_end
         FROM (SELECT (date_trunc('day', now() AT TIME ZONE $1::text)
                       - (($2::int - 1) * INTERVAL '1 day')) AT TIME ZONE $1::text AS s) x`,
      [TZ, days],
    );
    return { start: row.start, end: row.end, prevStart: row.prev_start, prevEnd: row.prev_end };
  }

  /** Every chart bucket in the current period, so empty hours/days still plot as 0. */
  private async buckets(start: Date, unit: string): Promise<string[]> {
    const rows = await this.dataSource.query(
      `SELECT to_char(g, 'YYYY-MM-DD"T"HH24:MI') AS b
         FROM generate_series(
                date_trunc($3::text, $1::timestamptz AT TIME ZONE $2::text),
                date_trunc($3::text, now() AT TIME ZONE $2::text),
                ('1 ' || $3)::interval) g`,
      [start, TZ, unit],
    );
    return rows.map((r: any) => r.b);
  }

  /** Chart bucket key for `col`; tz / unit are the placeholders holding them. */
  private bucketSql(col: string, tz = '$5', unit = '$6'): string {
    return `to_char(date_trunc(${unit}::text, ${col} AT TIME ZONE ${tz}::text), 'YYYY-MM-DD"T"HH24:MI')`;
  }

  // ── wagering ─────────────────────────────────────────────────────

  /**
   * Every wager ledger row in [$1, $3) as (user_id, category, stake, payout, ts).
   * Same per-source rules as game-history.service.ts.
   */
  private wagerRowsSql(): string {
    const win = (col: string) => `${col} >= $1::timestamptz AND ${col} < $3::timestamptz`;
    return `
      SELECT b.user_id::bigint AS user_id,
             CASE WHEN g.display_category = 'JACKPOT' THEN 'JACKPOT' ELSE 'LOTTERY' END AS category,
             (CASE WHEN b.result_status <> 'CANCELLED' THEN b.bet_amount ELSE 0 END)::numeric AS stake,
             (CASE WHEN b.result_status = 'WON' THEN b.potential_payout ELSE 0 END)::numeric AS payout,
             b.placed_at AS ts
        FROM bets b JOIN games g ON g.id = b.game_id
       WHERE ${win('b.placed_at')}
      UNION ALL
      SELECT st.user_id::bigint, 'SLOT',
             (CASE WHEN st.type = 'bet' AND NOT st.is_cancelled THEN st.amount ELSE 0 END)::numeric,
             (CASE WHEN st.type = 'win' AND NOT st.is_cancelled THEN st.amount ELSE 0 END)::numeric,
             st.created_at
        FROM slot_transactions st
       WHERE ${win('st.created_at')}
      UNION ALL
      -- type 3/6/7/8 = void/refund: neither stake nor payout
      SELECT sb.user_id::bigint, 'SPORTS',
             (CASE WHEN sb.type IS NULL OR sb.type NOT IN ('3','6','7','8') THEN sb.amount ELSE 0 END)::numeric,
             (CASE WHEN sb.type IS NULL OR sb.type NOT IN ('3','6','7','8') THEN COALESCE(sb.win_amount, 0) ELSE 0 END)::numeric,
             sb.created_at
        FROM sports_bet_logs sb
       WHERE sb.user_id IS NOT NULL AND ${win('sb.created_at')}
      UNION ALL
      SELECT ot.user_id::bigint,
             CASE WHEN ot.vendor_code LIKE 'fishing-%' THEN 'FISHING'
                  WHEN ot.vendor_code LIKE 'mini-%'    THEN 'CRASH'
                  WHEN ot.vendor_code LIKE 'poker-%'   THEN 'POKER'
                  ELSE 'LIVE' END,
             (CASE WHEN ot.amount < 0 AND NOT ot.is_canceled THEN -ot.amount ELSE 0 END)::numeric,
             (CASE WHEN ot.amount > 0 AND NOT ot.is_canceled THEN ot.amount ELSE 0 END)::numeric,
             ot.created_at
        FROM oroplay_transactions ot
       WHERE ${win('ot.created_at')}
      UNION ALL
      SELECT nt.user_id::bigint,
             CASE nt.game_type WHEN 'slot' THEN 'SLOT' WHEN 'live' THEN 'LIVE'
                               WHEN 'SB' THEN 'SPORTS' WHEN 'MN' THEN 'CRASH'
                               WHEN 'FT' THEN 'FISHING' WHEN 'FH' THEN 'FISHING'
                               ELSE 'SLOT' END,
             (CASE WHEN NOT nt.is_canceled THEN COALESCE(nt.bet_money, 0) ELSE 0 END)::numeric,
             (CASE WHEN NOT nt.is_canceled THEN COALESCE(nt.win_money, 0) ELSE 0 END)::numeric,
             nt.created_at
        FROM nexus_transactions nt
       WHERE ${win('nt.created_at')}
    `;
    // NOTE vs the source repo this was ported from: its `game_provider_*`
    // branch is dropped — that aggregator does not exist here — and its
    // `nexusggr_transactions` is this repo's `nexus_transactions`.
  }

  private async wagerAggregates(p: Period, unit: string) {
    const rows = await this.dataSource.query(
      `WITH w AS (${this.wagerRowsSql()}),
            t AS (
              SELECT user_id, category, stake, payout,
                     ts >= $2::timestamptz AS is_cur,
                     CASE WHEN ts >= $2::timestamptz THEN ${this.bucketSql('ts')} END AS bucket
                FROM w
               WHERE ts >= $2::timestamptz OR ts < $4::timestamptz
            )
       SELECT GROUPING(category) AS g_cat, GROUPING(bucket) AS g_bucket,
              is_cur, category, bucket,
              COALESCE(SUM(stake), 0)  AS turnover,
              COALESCE(SUM(payout), 0) AS payout,
              COUNT(DISTINCT user_id) FILTER (WHERE stake > 0)::int AS players
         FROM t
        GROUP BY GROUPING SETS ((is_cur), (is_cur, category), (is_cur, bucket))`,
      [p.prevStart, p.start, p.end, p.prevEnd, TZ, unit],
    );

    const zero = { turnover: 0, payout: 0, ggr: 0, players: 0 };
    const total = { cur: { ...zero }, prev: { ...zero } };
    const byCategory: { category: string; turnover: number; ggr: number; players: number }[] = [];
    const series: Record<string, { turnover: number; payout: number; players: number }> = {};

    for (const r of rows) {
      const turnover = this.r2(parseFloat(r.turnover));
      const payout = this.r2(parseFloat(r.payout));
      const players = Number(r.players);
      const gCat = Number(r.g_cat);
      const gBucket = Number(r.g_bucket);
      if (gCat === 1 && gBucket === 1) {
        total[r.is_cur ? 'cur' : 'prev'] = { turnover, payout, ggr: this.r2(turnover - payout), players };
      } else if (gCat === 0 && r.is_cur) {
        byCategory.push({ category: r.category, turnover, ggr: this.r2(turnover - payout), players });
      } else if (gBucket === 0 && r.is_cur && r.bucket) {
        series[r.bucket] = { turnover, payout, players };
      }
    }
    return { total, byCategory, series };
  }

  // ── cash, registrations, bonuses ─────────────────────────────────

  private async cashAggregates(p: Period, unit: string) {
    const win = (col: string) => `${col} >= $1::timestamptz AND ${col} < $3::timestamptz`;
    const [rows, loggedIn] = await Promise.all([
      this.dataSource.query(
        `WITH r AS (
           SELECT 'DEPOSIT' AS kind, d.amount::numeric AS amount, d.decided_at AS ts
             -- The source repo also excluded test deposits via an is_test
             -- column; this schema has none, so every approved deposit counts.
             FROM deposits d WHERE d.status = 'APPROVED' AND ${win('d.decided_at')}
           UNION ALL
           SELECT 'WITHDRAWAL', x.amount::numeric, x.decided_at
             FROM withdrawals x WHERE x.status = 'APPROVED' AND ${win('x.decided_at')}
           UNION ALL
           SELECT 'REGISTRATION', 0::numeric, u.created_at
             FROM users u WHERE ${win('u.created_at')}
           UNION ALL
           SELECT 'BONUS_PROMOTION', c.bonus_amount::numeric, c.claimed_at
             FROM user_promotion_claims c
            WHERE c.status IN ('ACTIVE','COMPLETED') AND ${win('c.claimed_at')}
           UNION ALL
           -- refer-a-friend credits (NOT affiliate commission)
           SELECT 'BONUS_REFERRAL', fl.amount::numeric, fl.created_at
             FROM financial_ledger fl
            WHERE fl.entry_type = 'REFERRAL_BONUS_CREDIT' AND fl.status = 'SUCCESS'
              AND ${win('fl.created_at')}
           UNION ALL
           SELECT 'BONUS_SPIN', sr.amount::numeric, sr.created_at
             FROM spin_results sr WHERE sr.amount > 0 AND ${win('sr.created_at')}
         )
         SELECT kind, ts >= $2::timestamptz AS is_cur,
                CASE WHEN ts >= $2::timestamptz THEN ${this.bucketSql('ts')} END AS bucket,
                COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0) AS amount
           FROM r
          WHERE ts >= $2::timestamptz OR ts < $4::timestamptz
          GROUP BY 1, 2, 3`,
        [p.prevStart, p.start, p.end, p.prevEnd, TZ, unit],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS n FROM users WHERE last_login_at >= $1 AND last_login_at < $2`,
        [p.start, p.end],
      ),
    ]);

    const totals: Record<string, { count: number; amount: number }> = {};
    const series: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      const key = `${r.kind}:${r.is_cur ? 'cur' : 'prev'}`;
      const amount = parseFloat(r.amount);
      const t = (totals[key] ??= { count: 0, amount: 0 });
      t.count += Number(r.cnt);
      t.amount = this.r2(t.amount + amount);
      if (r.is_cur && r.bucket) {
        const s = (series[r.bucket] ??= {});
        if (r.kind === 'REGISTRATION') s.REGISTRATION_COUNT = Number(r.cnt);
        else s[r.kind] = this.r2(amount);
      }
    }
    return { totals, series, loggedIn: loggedIn[0].n as number };
  }

  // ── queues (not period-bound: pending is pending) ────────────────

  private async pendingQueues() {
    const [row] = await this.dataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM deposits    WHERE status = 'PENDING')::int                  AS dep_cnt,
         (SELECT COALESCE(SUM(amount),0) FROM deposits    WHERE status = 'PENDING')          AS dep_amt,
         (SELECT COUNT(*) FROM withdrawals WHERE status = 'PENDING')::int                  AS wd_cnt,
         (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status = 'PENDING')          AS wd_amt,
         -- Only submissions with documents are review work. A status an admin
         -- set directly (no documents) has nothing to review.
         (SELECT COUNT(*) FROM user_verifications
           WHERE status IN ('PENDING','UNDER_REVIEW') AND front_image_url IS NOT NULL)::int AS kyc_cnt`,
    );
    return {
      deposits: { count: row.dep_cnt, amount: this.r2(parseFloat(row.dep_amt)) },
      withdrawals: { count: row.wd_cnt, amount: this.r2(parseFloat(row.wd_amt)) },
      kyc: { count: row.kyc_cnt },
    };
  }

  /** Oldest first: the longest-waiting player is the one to approve next. */
  private async latestPendingDeposits(limit = 5) {
    const rows = await this.dataSource.query(
      `SELECT d.id, d.deposit_code, d.amount, d.requested_at,
              u.id AS user_id, u.username, u.user_code,
              g.name AS gateway_name, g.type AS gateway_type, a.wallet_type,
              FLOOR(EXTRACT(EPOCH FROM (now() - d.requested_at)) / 60)::int AS waiting_minutes
         FROM deposits d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN payment_gateways g ON g.id = d.gateway_id
         LEFT JOIN agents a ON a.id = d.agent_id
        WHERE d.status = 'PENDING'
        ORDER BY d.requested_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows.map((r: any) => ({
      id: Number(r.id),
      depositCode: r.deposit_code,
      userId: Number(r.user_id),
      username: r.username,
      userCode: r.user_code,
      method: r.gateway_name ?? r.wallet_type ?? null,
      // CRYPTO approvals need the BDT credit amount typed in, so the
      // dashboard's one-click Approve must not be used for them.
      isCrypto: r.gateway_type === 'CRYPTO',
      amount: this.r2(parseFloat(r.amount)),
      requestedAt: r.requested_at,
      waitingMinutes: r.waiting_minutes,
    }));
  }

  // ── big wins ─────────────────────────────────────────────────────

  /**
   * Latest rounds in the period that paid at least `minWin` AND at least
   * `multiplier`× their stake. Collapsed per round like game-history, since
   * one slot round arrives as many ledger rows (tumbles, free spins).
   */
  private async bigWins(p: Period, multiplier: number, minWin: number, limit = 5) {
    const win = (col: string) => `${col} >= $1::timestamptz AND ${col} < $2::timestamptz`;
    const rows = await this.dataSource.query(
      `WITH rounds AS (
         SELECT 'SLOT' AS category, st.user_id::bigint AS user_id,
                MAX(st.game_code) AS game_name, MAX(pp.name) AS provider,
                SUM(st.amount) FILTER (WHERE st.type = 'bet' AND NOT st.is_cancelled) AS bet,
                SUM(st.amount) FILTER (WHERE st.type = 'win' AND NOT st.is_cancelled) AS win,
                MAX(st.created_at) AS won_at
           FROM slot_transactions st
           LEFT JOIN palace_providers pp ON pp.provider_id = st.provider_id
          WHERE ${win('st.created_at')}
          GROUP BY st.user_id, COALESCE(st.round_id, st.trans_guid)
         UNION ALL
         SELECT CASE WHEN MAX(ot.vendor_code) LIKE 'fishing-%' THEN 'FISHING'
                     WHEN MAX(ot.vendor_code) LIKE 'mini-%'    THEN 'CRASH'
                     WHEN MAX(ot.vendor_code) LIKE 'poker-%'   THEN 'POKER'
                     ELSE 'LIVE' END,
                ot.user_id::bigint, MAX(ot.game_code), MAX(ot.vendor_code),
                SUM(-ot.amount) FILTER (WHERE ot.amount < 0 AND NOT ot.is_canceled),
                SUM(ot.amount)  FILTER (WHERE ot.amount > 0 AND NOT ot.is_canceled),
                MAX(ot.created_at)
           FROM oroplay_transactions ot
          WHERE ${win('ot.created_at')}
          GROUP BY ot.user_id, COALESCE(ot.round_id, ot.transaction_code)
         UNION ALL
         SELECT CASE MAX(nt.game_type) WHEN 'slot' THEN 'SLOT' WHEN 'live' THEN 'LIVE'
                                       WHEN 'SB' THEN 'SPORTS' WHEN 'MN' THEN 'CRASH'
                                       WHEN 'FT' THEN 'FISHING' WHEN 'FH' THEN 'FISHING'
                                       ELSE 'SLOT' END,
                nt.user_id::bigint,
                COALESCE(MAX(cg.name), MAX(nt.game_code)), MAX(nt.provider_code),
                SUM(nt.bet_money) FILTER (WHERE NOT nt.is_canceled),
                SUM(nt.win_money) FILTER (WHERE NOT nt.is_canceled),
                MAX(nt.created_at)
           FROM nexus_transactions nt
           LEFT JOIN casino_games cg
             ON cg.vendor_code = nt.provider_code AND cg.game_code = nt.game_code
          WHERE ${win('nt.created_at')}
          GROUP BY nt.user_id, COALESCE(nt.round_id, nt.txn_id)
         UNION ALL
         SELECT 'SPORTS', sb.user_id::bigint,
                COALESCE(NULLIF(sb.bet_list->'selections'->0->>'eventName', ''), 'Sportsbook'),
                'Sportsbook', sb.amount::numeric, sb.win_amount::numeric,
                COALESCE(sb.settled_at, sb.created_at)
           FROM sports_bet_logs sb
          WHERE sb.user_id IS NOT NULL AND sb.win_amount > 0
            AND (sb.type IS NULL OR sb.type NOT IN ('3','6','7','8'))
            AND ${win('COALESCE(sb.settled_at, sb.created_at)')}
         UNION ALL
         SELECT CASE WHEN g.display_category = 'JACKPOT' THEN 'JACKPOT' ELSE 'LOTTERY' END,
                b.user_id::bigint, g.name, NULL,
                b.bet_amount::numeric, b.potential_payout::numeric,
                COALESCE(b.settled_at, b.placed_at)
           FROM bets b JOIN games g ON g.id = b.game_id
          WHERE b.result_status = 'WON'
            AND ${win('COALESCE(b.settled_at, b.placed_at)')}
       )
       SELECT r.category, r.game_name, r.provider, r.bet, r.win, r.won_at,
              u.id AS user_id, u.username, u.user_code
         FROM rounds r
         JOIN users u ON u.id = r.user_id
        WHERE r.win >= $3 AND r.bet > 0 AND r.win >= $4 * r.bet
        ORDER BY r.won_at DESC
        LIMIT $5`,
      [p.start, p.end, minWin, multiplier, limit],
    );
    return rows.map((r: any) => {
      const bet = parseFloat(r.bet);
      const winAmt = parseFloat(r.win);
      return {
        userId: Number(r.user_id),
        username: r.username,
        userCode: r.user_code,
        category: r.category,
        game: r.game_name,
        provider: r.provider,
        bet: this.r2(bet),
        win: this.r2(winAmt),
        multiplier: bet > 0 ? Math.round((winAmt / bet) * 10) / 10 : null,
        wonAt: r.won_at,
      };
    });
  }

  // ── spin wheel ───────────────────────────────────────────────────

  private async spinKpis(p: Period, unit: string) {
    const [agg, series, byWheel, topWins, wheels] = await Promise.all([
      this.dataSource.query(
        `SELECT sr.created_at >= $2 AS is_cur,
                COUNT(*)::int                               AS spins,
                COUNT(DISTINCT sr.user_id)::int             AS players,
                COUNT(*) FILTER (WHERE sr.amount > 0)::int  AS winning,
                COALESCE(SUM(sr.amount), 0)                 AS paid,
                COALESCE(SUM(sr.turnover_target), 0)        AS turnover_target
           FROM spin_results sr
          WHERE sr.created_at >= $1 AND sr.created_at < $3
            AND (sr.created_at >= $2 OR sr.created_at < $4)
          GROUP BY 1`,
        [p.prevStart, p.start, p.end, p.prevEnd],
      ),
      this.dataSource.query(
        `SELECT ${this.bucketSql('sr.created_at', '$3', '$4')} AS bucket,
                COUNT(*)::int AS spins, COALESCE(SUM(sr.amount), 0) AS paid
           FROM spin_results sr
          WHERE sr.created_at >= $1 AND sr.created_at < $2
          GROUP BY 1`,
        [p.start, p.end, TZ, unit],
      ),
      this.dataSource.query(
        `SELECT w.id, w.name, w.is_active,
                COUNT(sr.id)::int                          AS spins,
                COUNT(DISTINCT sr.user_id)::int            AS players,
                COALESCE(SUM(sr.amount), 0)                AS paid
           FROM spin_results sr
           JOIN spin_wheels w ON w.id = sr.wheel_id
          WHERE sr.created_at >= $1 AND sr.created_at < $2
          GROUP BY w.id, w.name, w.is_active
          ORDER BY spins DESC
          LIMIT 5`,
        [p.start, p.end],
      ),
      this.dataSource.query(
        `SELECT sr.id, sr.amount, sr.segment_label, sr.created_at,
                w.name AS wheel_name, u.id AS user_id, u.username
           FROM spin_results sr
           JOIN spin_wheels w ON w.id = sr.wheel_id
           JOIN users u ON u.id = sr.user_id
          WHERE sr.created_at >= $1 AND sr.created_at < $2 AND sr.amount > 0
          ORDER BY sr.amount DESC, sr.created_at DESC
          LIMIT 5`,
        [p.start, p.end],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) FILTER (WHERE is_active
                                  AND (starts_at IS NULL OR starts_at <= now())
                                  AND (ends_at   IS NULL OR ends_at   >  now()))::int AS live,
                COUNT(*)::int AS total
           FROM spin_wheels`,
      ),
    ]);

    const pick = (cur: boolean) => {
      const r = agg.find((x: any) => x.is_cur === cur);
      return {
        spins: r ? Number(r.spins) : 0,
        players: r ? Number(r.players) : 0,
        winning: r ? Number(r.winning) : 0,
        paid: r ? parseFloat(r.paid) : 0,
        turnoverTarget: r ? parseFloat(r.turnover_target) : 0,
      };
    };
    const c = pick(true);
    const pr = pick(false);

    return {
      liveWheels: wheels[0].live,
      totalWheels: wheels[0].total,
      spins: this.kpi(c.spins, pr.spins),
      players: this.kpi(c.players, pr.players),
      paid: this.kpi(c.paid, pr.paid),
      winRatePct: c.spins > 0 ? this.r2((c.winning / c.spins) * 100) : 0,
      avgPerSpin: c.spins > 0 ? this.r2(c.paid / c.spins) : 0,
      // Wagering the spin prizes raised — what the house gets back before
      // those prizes can be withdrawn.
      turnoverRaised: this.r2(c.turnoverTarget),
      // Keyed by bucket; merged into the main `series` so empty buckets plot as 0.
      seriesByBucket: Object.fromEntries(
        series.map((s: any) => [s.bucket, { spins: Number(s.spins), paid: this.r2(parseFloat(s.paid)) }]),
      ) as Record<string, { spins: number; paid: number }>,
      byWheel: byWheel.map((w: any) => ({
        wheelId: Number(w.id),
        name: w.name,
        isActive: w.is_active,
        spins: Number(w.spins),
        players: Number(w.players),
        paid: this.r2(parseFloat(w.paid)),
      })),
      topWins: topWins.map((t: any) => ({
        id: Number(t.id),
        userId: Number(t.user_id),
        username: t.username,
        wheel: t.wheel_name,
        segment: t.segment_label,
        amount: this.r2(parseFloat(t.amount)),
        createdAt: t.created_at,
      })),
    };
  }
}

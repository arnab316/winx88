// src/reports/reports.service.ts
//
// Per-player financial reporting (build-guide §6.2). Read-only aggregates
// across deposits, withdrawals, bets, bonuses, manual adjustments and
// referral commission. Uses raw SQL against the existing schema — there is
// no dedicated materialized view yet, so the list endpoint is paginated and
// date-boundable to keep it cheap on large player tables.
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as XLSX from 'xlsx';
import {
  PlayerReportQueryDto,
  PlayerDrillQueryDto,
  MemberSummaryQueryDto,
} from './dto/reports.dto';

@Injectable()
export class ReportsService {
  constructor(private dataSource: DataSource) {}

  // Inclusive lower / exclusive upper date bounds, applied per-table.
  private dateBounds(startDate?: string, endDate?: string) {
    return {
      start: startDate ?? null,
      end: endDate ?? null,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // GET /reports/players — paginated per-player aggregate rows
  // ═════════════════════════════════════════════════════════════
  async getPlayerReports(q: PlayerReportQueryDto) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const offset = (page - 1) * limit;
    const { start, end } = this.dateBounds(q.startDate, q.endDate);

    const params: any[] = [start, end];
    let i = 3;
    let searchSql = '';
    if (q.search) {
      searchSql = `AND (u.username ILIKE $${i} OR u.user_code ILIKE $${i} OR u.full_name ILIKE $${i})`;
      params.push(`%${q.search}%`);
      i++;
    }

    params.push(limit, offset);

    // $1 = start, $2 = end (NULL-tolerant via COALESCE bounds in subqueries)
    const rows = await this.dataSource.query(
      `
      SELECT
        u.id, u.user_code, u.username, u.full_name, u.vip_level, u.account_status,
        u.created_at,
        w.balance, w.bonus_balance, w.locked_balance,
        COALESCE(dep.cnt, 0)        AS deposit_count,
        COALESCE(dep.total, 0)      AS deposit_total,
        COALESCE(wd.cnt, 0)         AS withdrawal_count,
        COALESCE(wd.total, 0)       AS withdrawal_total,
        COALESCE(w.total_bet, 0)    AS total_bet,
        COALESCE(w.total_win, 0)    AS total_win,
        (COALESCE(w.total_win,0) - COALESCE(w.total_bet,0)) AS net_win_loss,
        COALESCE(bn.total, 0)       AS bonus_total,
        COALESCE(adj.total, 0)      AS adjustment_total,
        COALESCE(rb.total, 0)       AS referral_bonus_total,
        (COALESCE(dep.total,0) - COALESCE(wd.total,0)) AS net_deposit
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, SUM(amount) AS total
          FROM deposits d
         WHERE d.user_id = u.id AND d.status = 'APPROVED'
           AND ($1::timestamptz IS NULL OR d.decided_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR d.decided_at <  $2::timestamptz)
      ) dep ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, SUM(amount) AS total
          FROM withdrawals x
         WHERE x.user_id = u.id AND x.status = 'APPROVED'
           AND ($1::timestamptz IS NULL OR x.decided_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR x.decided_at <  $2::timestamptz)
      ) wd ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(bonus_amount) AS total
          FROM user_promotion_claims c
         WHERE c.user_id = u.id AND c.status IN ('ACTIVE','COMPLETED')
           AND ($1::timestamptz IS NULL OR c.claimed_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR c.claimed_at <  $2::timestamptz)
      ) bn ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS total
          FROM manual_adjustments m
         WHERE m.user_id = u.id
           AND ($1::timestamptz IS NULL OR m.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR m.created_at <  $2::timestamptz)
      ) adj ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS total
          FROM referral_bonus r
         WHERE r.referrer_user_id = u.id AND r.status = 'APPROVED'
           AND ($1::timestamptz IS NULL OR r.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR r.created_at <  $2::timestamptz)
      ) rb ON TRUE
      WHERE 1 = 1 ${searchSql}
      ORDER BY u.created_at DESC
      LIMIT $${i++} OFFSET $${i++}
      `,
      params,
    );

    const countParams: any[] = [];
    let searchCountSql = '';
    if (q.search) {
      searchCountSql = `AND (u.username ILIKE $1 OR u.user_code ILIKE $1 OR u.full_name ILIKE $1)`;
      countParams.push(`%${q.search}%`);
    }
    const totalRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM users u WHERE 1 = 1 ${searchCountSql}`,
      countParams,
    );

    return { data: rows, page, limit, total: totalRows[0].total };
  }

  // ═════════════════════════════════════════════════════════════
  // GET /reports/member-summary — one row per member, all money
  // column groups of the admin Report page. Shape mirrors the
  // frontend ReportData interface exactly.
  // ═════════════════════════════════════════════════════════════
  //
  // Column semantics (v1):
  //   deposit/withdrawal  — APPROVED rows, bounded by decided_at.
  //                         fee = 0: no fee column exists in the schema yet.
  //   adjustment          — manual_adjustments; in = credits, out = |debits|.
  //   bet                 — union of all four wager sources, same per-source
  //                         rules as the unified game-history service:
  //                         bets (lottery/jackpot), slot_transactions,
  //                         sports_bet_logs, oroplay_transactions.
  //                         validAmount excludes cancelled wagers;
  //                         settleAmount = payouts; winLoss = settle − valid.
  //   bet.turnover        — turnover_ledger CONTRIBUTION sum.
  //   promotion           — user_promotion_claims (ACTIVE/COMPLETED):
  //                         bonusTurnover = all bonus credited,
  //                         depositBonus = deposit-linked claims,
  //                         rebate = claims on kind REBATE promotions.
  //   vip                 — VIP coins earned (coin_ledger credits).
  //   referral.bonus      — refer-a-friend credits (financial_ledger
  //                         REFERRAL_BONUS_CREDIT).
  //   referral.commission — affiliate per-referee commission
  //                         (referral_bonus, APPROVED).
  //   referral counts / affiliateTransfer — member↔affiliate transfers do
  //                         not exist on this platform → always 0.
  async getMemberSummary(q: MemberSummaryQueryDto) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const offset = (page - 1) * limit;

    const { rows, total } = await this.memberSummaryRows(q, limit, offset);
    return {
      success: true,
      data: rows.map((r: any) => this.mapSummaryRow(r)),
      page,
      limit,
      total,
    };
  }

  /**
   * XLSX variant for the Export button (no pagination, hard cap).
   *
   * Username / Member ID are written as an actual .xlsx (not CSV) with those
   * two columns forced to Excel's Text format. A plain CSV can't express
   * "keep this as text" — Excel auto-detects any bare digit-only cell as a
   * Number on open, and long ids (e.g. phone-number usernames) collapse into
   * scientific notation with lost precision (`1349002233` -> `1.35E+09`).
   */
  async getMemberSummaryXlsx(q: MemberSummaryQueryDto): Promise<Buffer> {
    const { rows } = await this.memberSummaryRows(q, 10_000, 0);
    const data = rows.map((r: any) => this.mapSummaryRow(r));

    const header = [
      'Username', 'Member ID', 'Group Name',
      'Deposit Count', 'Deposit Total', 'Deposit Fee',
      'Withdrawal Count', 'Withdrawal Total', 'Withdrawal Fee',
      'Total Profit',
      'Adjustment Count', 'Adjustment In', 'Adjustment Out', 'Adjustment Total',
      'Bet Count', 'Bet Amount', 'Valid Amount', 'Settle Amount', 'Win/Loss', 'Turnover',
      'Promotion Bonus Turnover', 'VIP', 'Rebate', 'Deposit Bonus',
      'Referral Commission', 'Referral Bonus',
      'Count From Affiliate', 'Count To Affiliate',
      'Affiliate Transfer Count', 'Transfer From Affiliate', 'Transfer To Affiliate', 'Affiliate Transfer Total',
    ];
    const aoa = [
      header,
      ...data.map((d) => [
        d.username, d.memberId, d.groupName,
        d.deposit.count, d.deposit.total, d.deposit.fee,
        d.withdrawal.count, d.withdrawal.total, d.withdrawal.fee,
        d.totalProfit,
        d.adjustment.count, d.adjustment.in, d.adjustment.out, d.adjustment.total,
        d.bet.count, d.bet.amount, d.bet.validAmount, d.bet.settleAmount, d.bet.winLoss, d.bet.turnover,
        d.promotion.bonusTurnover, d.vip, d.rebate, d.depositBonus,
        d.referral.commission, d.referral.bonus,
        d.referral.countFromAffiliate, d.referral.countToAffiliate,
        d.affiliateTransfer.count, d.affiliateTransfer.transferFromAffiliate,
        d.affiliateTransfer.transferToAffiliate, d.affiliateTransfer.total,
      ]),
    ];

    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    // Username = column A, Member ID = column B. Both can be long digit-only
    // strings, so force Text format on every data row (row 0 is the header).
    for (const col of ['A', 'B']) {
      for (let row = 1; row < aoa.length; row++) {
        const cell = sheet[`${col}${row + 1}`];
        if (cell) {
          cell.t = 's';
          cell.z = '@';
        }
      }
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Member Summary');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  private async memberSummaryRows(
    q: MemberSummaryQueryDto,
    limit: number,
    offset: number,
  ): Promise<{ rows: any[]; total: number }> {
    // dateTo is an inclusive calendar date → exclusive upper bound = +1 day.
    const start = q.dateFrom ?? null;
    const end = q.dateTo
      ? new Date(new Date(q.dateTo.slice(0, 10) + 'T00:00:00Z').getTime() + 86_400_000)
          .toISOString()
          .slice(0, 10)
      : null;

    // The same filter set is used by two queries with different parameter
    // offsets, so the clause SQL is built per base index.
    const username = q.username?.trim();
    const group = q.memberGroup?.trim();
    const filterParams: any[] = [];
    if (username) filterParams.push(`%${username}%`);
    if (group) filterParams.push(group);
    const filterSql = (base: number): string => {
      let idx = base;
      const parts: string[] = [];
      if (username) { parts.push(`(u.username ILIKE $${idx} OR u.user_code ILIKE $${idx})`); idx++; }
      if (group) { parts.push(`(vlc.group_name ILIKE $${idx} OR vlc.level_name ILIKE $${idx})`); idx++; }
      return parts.length ? `AND ${parts.join(' AND ')}` : '';
    };

    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total
         FROM users u
         LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
        WHERE 1 = 1 ${filterSql(1)}`,
      filterParams,
    );

    const params: any[] = [start, end, ...filterParams, limit, offset];
    const limitIdx = 3 + filterParams.length;
    const rows = await this.dataSource.query(
      `
      SELECT
        u.id, u.username, u.user_code,
        COALESCE(vlc.group_name, vlc.level_name, 'Level ' || u.vip_level) AS group_name,
        COALESCE(dep.cnt, 0)  AS dep_cnt,  COALESCE(dep.total, 0)  AS dep_total,
        COALESCE(wd.cnt, 0)   AS wd_cnt,   COALESCE(wd.total, 0)   AS wd_total,
        COALESCE(adj.cnt, 0)  AS adj_cnt,  COALESCE(adj.adj_in, 0) AS adj_in,
        COALESCE(adj.adj_out, 0) AS adj_out, COALESCE(adj.total, 0) AS adj_total,
        COALESCE(lb.cnt,0) + COALESCE(sl.cnt,0) + COALESCE(sp.cnt,0) + COALESCE(op.cnt,0)             AS bet_cnt,
        COALESCE(lb.amount,0) + COALESCE(sl.amount,0) + COALESCE(sp.amount,0) + COALESCE(op.amount,0) AS bet_amount,
        COALESCE(lb.valid,0) + COALESCE(sl.valid,0) + COALESCE(sp.valid,0) + COALESCE(op.valid,0)     AS bet_valid,
        COALESCE(lb.settle,0) + COALESCE(sl.settle,0) + COALESCE(sp.settle,0) + COALESCE(op.settle,0) AS bet_settle,
        COALESCE(tv.total, 0)   AS turnover,
        COALESCE(pr.bonus_total, 0)   AS promo_bonus,
        COALESCE(pr.deposit_bonus, 0) AS deposit_bonus,
        COALESCE(pr.rebate, 0)        AS rebate,
        COALESCE(vc.coins, 0)         AS vip_coins,
        COALESCE(rfb.total, 0)        AS referral_bonus,
        COALESCE(rfc.total, 0)        AS referral_commission
      FROM users u
      LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, SUM(amount) AS total
          FROM deposits d
         WHERE d.user_id = u.id AND d.status = 'APPROVED'
           AND ($1::timestamptz IS NULL OR d.decided_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR d.decided_at <  $2::timestamptz)
      ) dep ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, SUM(amount) AS total
          FROM withdrawals x
         WHERE x.user_id = u.id AND x.status = 'APPROVED'
           AND ($1::timestamptz IS NULL OR x.decided_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR x.decided_at <  $2::timestamptz)
      ) wd ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt,
               SUM(amount) FILTER (WHERE amount > 0)  AS adj_in,
               SUM(-amount) FILTER (WHERE amount < 0) AS adj_out,
               SUM(amount) AS total
          FROM manual_adjustments m
         WHERE m.user_id = u.id
           AND ($1::timestamptz IS NULL OR m.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR m.created_at <  $2::timestamptz)
      ) adj ON TRUE
      -- lottery + jackpot wagers
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt,
               SUM(bet_amount) AS amount,
               SUM(bet_amount) FILTER (WHERE result_status <> 'CANCELLED') AS valid,
               SUM(potential_payout) FILTER (WHERE result_status = 'WON')  AS settle
          FROM bets b
         WHERE b.user_id = u.id
           AND ($1::timestamptz IS NULL OR b.placed_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR b.placed_at <  $2::timestamptz)
      ) lb ON TRUE
      -- Palace slots ledger rows
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE st.type = 'bet')::int AS cnt,
               SUM(st.amount) FILTER (WHERE st.type = 'bet') AS amount,
               SUM(st.amount) FILTER (WHERE st.type = 'bet' AND NOT st.is_cancelled) AS valid,
               SUM(st.amount) FILTER (WHERE st.type = 'win' AND NOT st.is_cancelled) AS settle
          FROM slot_transactions st
         WHERE st.user_id = u.id
           AND ($1::timestamptz IS NULL OR st.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR st.created_at <  $2::timestamptz)
      ) sl ON TRUE
      -- sportsbook slips (type 3/6/7/8 = cancelled, per game-history rules)
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt,
               SUM(sb.amount) AS amount,
               SUM(sb.amount) FILTER (WHERE sb.type IS NULL OR sb.type NOT IN ('3','6','7','8')) AS valid,
               SUM(sb.win_amount) AS settle
          FROM sports_bet_logs sb
         WHERE sb.user_id = u.id
           AND ($1::timestamptz IS NULL OR sb.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR sb.created_at <  $2::timestamptz)
      ) sp ON TRUE
      -- OroPlay ledger rows (amount < 0 = stake, > 0 = payout)
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE ot.amount < 0 AND NOT ot.is_canceled)::int AS cnt,
               SUM(-ot.amount) FILTER (WHERE ot.amount < 0 AND NOT ot.is_canceled) AS amount,
               SUM(-ot.amount) FILTER (WHERE ot.amount < 0 AND NOT ot.is_canceled) AS valid,
               SUM(ot.amount)  FILTER (WHERE ot.amount > 0 AND NOT ot.is_canceled) AS settle
          FROM oroplay_transactions ot
         WHERE ot.user_id = u.id
           AND ($1::timestamptz IS NULL OR ot.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR ot.created_at <  $2::timestamptz)
      ) op ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS total
          FROM turnover_ledger tl
         WHERE tl.user_id = u.id AND tl.event_type = 'CONTRIBUTION'
           AND ($1::timestamptz IS NULL OR tl.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR tl.created_at <  $2::timestamptz)
      ) tv ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(c.bonus_amount) AS bonus_total,
               SUM(c.bonus_amount) FILTER (WHERE c.deposit_id IS NOT NULL) AS deposit_bonus,
               SUM(c.bonus_amount) FILTER (WHERE p.kind = 'REBATE')        AS rebate
          FROM user_promotion_claims c
          LEFT JOIN promotions p ON p.id = c.promotion_id
         WHERE c.user_id = u.id AND c.status IN ('ACTIVE','COMPLETED')
           AND ($1::timestamptz IS NULL OR c.claimed_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR c.claimed_at <  $2::timestamptz)
      ) pr ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(coins) FILTER (WHERE coins > 0) AS coins
          FROM coin_ledger cl
         WHERE cl.user_id = u.id
           AND ($1::timestamptz IS NULL OR cl.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR cl.created_at <  $2::timestamptz)
      ) vc ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS total
          FROM financial_ledger fl
         WHERE fl.user_id = u.id AND fl.entry_type = 'REFERRAL_BONUS_CREDIT'
           AND fl.status = 'SUCCESS'
           AND ($1::timestamptz IS NULL OR fl.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR fl.created_at <  $2::timestamptz)
      ) rfb ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS total
          FROM referral_bonus r
         WHERE r.referrer_user_id = u.id AND r.status = 'APPROVED'
           AND ($1::timestamptz IS NULL OR r.created_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR r.created_at <  $2::timestamptz)
      ) rfc ON TRUE
      WHERE 1 = 1 ${filterSql(3)}
      ORDER BY u.created_at DESC
      LIMIT $${limitIdx} OFFSET $${limitIdx + 1}
      `,
      params,
    );
    return { rows, total };
  }

  /** DB row → the nested ReportData shape the Report page consumes. */
  private mapSummaryRow(r: any) {
    const n = (v: any) => Number(v ?? 0);
    const depTotal = n(r.dep_total);
    const wdTotal = n(r.wd_total);
    const valid = n(r.bet_valid);
    const settle = n(r.bet_settle);
    return {
      id: Number(r.id),
      username: r.username,
      memberId: r.user_code,
      groupName: r.group_name,
      deposit: { count: n(r.dep_cnt), total: depTotal, fee: 0 },
      withdrawal: { count: n(r.wd_cnt), total: wdTotal, fee: 0 },
      totalProfit: depTotal - wdTotal,
      adjustment: {
        count: n(r.adj_cnt),
        in: n(r.adj_in),
        out: n(r.adj_out),
        total: n(r.adj_total),
      },
      bet: {
        count: n(r.bet_cnt),
        amount: n(r.bet_amount),
        validAmount: valid,
        settleAmount: settle,
        winLoss: settle - valid,
        turnover: n(r.turnover),
      },
      promotion: { bonusTurnover: n(r.promo_bonus) },
      vip: n(r.vip_coins),
      rebate: n(r.rebate),
      depositBonus: n(r.deposit_bonus),
      referral: {
        commission: n(r.referral_commission),
        bonus: n(r.referral_bonus),
        countFromAffiliate: 0,
        countToAffiliate: 0,
      },
      affiliateTransfer: {
        count: 0,
        transferFromAffiliate: 0,
        transferToAffiliate: 0,
        total: 0,
      },
    };
  }

  // ═════════════════════════════════════════════════════════════
  // GET /reports/players/:userId — single-player aggregate drill
  // ═════════════════════════════════════════════════════════════
  async getPlayerReport(userId: number, q: PlayerDrillQueryDto) {
    const { start, end } = this.dateBounds(q.startDate, q.endDate);
    const rows = await this.dataSource.query(
      `
      SELECT
        u.id, u.user_code, u.username, u.full_name, u.email, u.vip_level,
        u.account_status, u.is_kyc_verified, u.created_at,
        w.balance, w.bonus_balance, w.locked_balance,
        w.total_deposited, w.total_withdrawn, w.total_bet, w.total_win,
        COALESCE(dep.cnt,0) AS deposit_count, COALESCE(dep.total,0) AS deposit_total,
        COALESCE(wd.cnt,0)  AS withdrawal_count, COALESCE(wd.total,0) AS withdrawal_total,
        COALESCE(bet.cnt,0) AS bet_count, COALESCE(bet.amount,0) AS bet_amount,
        COALESCE(bet.win_loss,0) AS bet_win_loss,
        COALESCE(bn.total,0)  AS bonus_total,
        COALESCE(adj.total,0) AS adjustment_total,
        COALESCE(rb.total,0)  AS referral_bonus_total
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, SUM(amount) AS total FROM deposits d
         WHERE d.user_id = u.id AND d.status = 'APPROVED'
           AND ($2::timestamptz IS NULL OR d.decided_at >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR d.decided_at <  $3::timestamptz)
      ) dep ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, SUM(amount) AS total FROM withdrawals x
         WHERE x.user_id = u.id AND x.status = 'APPROVED'
           AND ($2::timestamptz IS NULL OR x.decided_at >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR x.decided_at <  $3::timestamptz)
      ) wd ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, SUM(bet_amount) AS amount,
               SUM(CASE WHEN result_status = 'WON'  THEN potential_payout ELSE 0 END)
             - SUM(bet_amount) AS win_loss
          FROM bets b
         WHERE b.user_id = u.id
           AND ($2::timestamptz IS NULL OR b.placed_at >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR b.placed_at <  $3::timestamptz)
      ) bet ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(bonus_amount) AS total FROM user_promotion_claims c
         WHERE c.user_id = u.id AND c.status IN ('ACTIVE','COMPLETED')
      ) bn ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS total FROM manual_adjustments m WHERE m.user_id = u.id
      ) adj ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS total FROM referral_bonus r
         WHERE r.referrer_user_id = u.id AND r.status = 'APPROVED'
      ) rb ON TRUE
      WHERE u.id = $1
      `,
      [userId, start, end],
    );
    if (!rows.length) throw new NotFoundException('User not found');
    return rows[0];
  }

  // ═════════════════════════════════════════════════════════════
  // GET /reports/players/:userId/bets — per-game bet summary
  // ═════════════════════════════════════════════════════════════
  async getPlayerBets(userId: number, q: PlayerDrillQueryDto) {
    const { start, end } = this.dateBounds(q.startDate, q.endDate);
    return this.dataSource.query(
      `
      SELECT g.id AS game_id, g.code AS game_code, g.name AS game_name,
             g.display_category,
             COUNT(b.id)::int AS bet_count,
             SUM(b.bet_amount) AS total_bet,
             SUM(CASE WHEN b.result_status = 'WON' THEN b.potential_payout ELSE 0 END) AS total_won,
             SUM(CASE WHEN b.result_status = 'LOST' THEN b.bet_amount ELSE 0 END) AS total_lost,
             (SUM(CASE WHEN b.result_status = 'WON' THEN b.potential_payout ELSE 0 END)
              - SUM(b.bet_amount)) AS net_win_loss
        FROM bets b
        JOIN games g ON g.id = b.game_id
       WHERE b.user_id = $1
         AND ($2::timestamptz IS NULL OR b.placed_at >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR b.placed_at <  $3::timestamptz)
       GROUP BY g.id, g.code, g.name, g.display_category
       ORDER BY total_bet DESC NULLS LAST
      `,
      [userId, start, end],
    );
  }

  // ═════════════════════════════════════════════════════════════
  // GET /reports/players/:userId/transactions — deposits + withdrawals
  // ═════════════════════════════════════════════════════════════
  async getPlayerTransactions(userId: number, q: PlayerDrillQueryDto) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const offset = (page - 1) * limit;
    const { start, end } = this.dateBounds(q.startDate, q.endDate);

    const data = await this.dataSource.query(
      `
      SELECT * FROM (
        SELECT 'DEPOSIT' AS kind, deposit_code AS code, amount, status,
               requested_at, decided_at, rejection_reason
          FROM deposits WHERE user_id = $1
        UNION ALL
        SELECT 'WITHDRAWAL' AS kind, withdrawal_code AS code, amount, status,
               requested_at, decided_at, rejection_reason
          FROM withdrawals WHERE user_id = $1
      ) t
      WHERE ($2::timestamptz IS NULL OR t.requested_at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR t.requested_at <  $3::timestamptz)
      ORDER BY t.requested_at DESC
      LIMIT $4 OFFSET $5
      `,
      [userId, start, end, limit, offset],
    );

    return { data, page, limit };
  }
}

// src/reports/reports.service.ts
//
// Per-player financial reporting (build-guide §6.2). Read-only aggregates
// across deposits, withdrawals, bets, bonuses, manual adjustments and
// referral commission. Uses raw SQL against the existing schema — there is
// no dedicated materialized view yet, so the list endpoint is paginated and
// date-boundable to keep it cheap on large player tables.
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PlayerReportQueryDto, PlayerDrillQueryDto } from './dto/reports.dto';

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

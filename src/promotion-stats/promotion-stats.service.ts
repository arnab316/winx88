// src/promotion-stats/promotion-stats.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StatsQueryDto, QuickRange } from './dto/promotion-stats.dto';

/**
 * Read-only analytics over user_promotion_claims + deposits + bets.
 *
 * Per the doc (Section 5 — Promotion Statistics Workflow):
 *   - Unique players, total claims, claim-frequency-velocity
 *   - Total deposit, total bonus, total win/loss
 *   - Filterable by currency, date range, specific promotion
 *
 * Win/loss semantics (since bets table has no win_amount column):
 *   - result_status = 'WON'   → player net = potential_payout - bet_amount
 *   - result_status = 'LOST'  → player net = -bet_amount
 *   - result_status = 'PLACED' or 'CANCELLED' → excluded (unsettled)
 *
 * `total_win_loss` is FROM THE PLAYER'S perspective:
 *   positive = players profited (bad for house)
 *   negative = players lost  (good for house)
 */
@Injectable()
export class PromotionStatsService {
  constructor(private readonly dataSource: DataSource) {}

  // ═════════════════════════════════════════════════════════════
  // MASTER GRID
  // ═════════════════════════════════════════════════════════════
  async overview(q: StatsQueryDto) {
    const { startSql, endSql, params } = this.buildRange(q);
    const currency = q.currency ?? 'BDT';

    // Shared promotion filters (status / code search / single promo). Inlined
    // safely: status is enum-validated; code is escaped; id is numeric.
    const promoFilters: string[] = [];
    if (q.status === 'ACTIVE')   promoFilters.push('AND p.is_active = TRUE');
    if (q.status === 'INACTIVE') promoFilters.push('AND p.is_active = FALSE');
    if (q.promotionId)           promoFilters.push(`AND p.id = ${Number(q.promotionId)}`);
    if (q.code)                  promoFilters.push(`AND p.code ILIKE '%${String(q.code).replace(/'/g, "''")}%'`);
    const promoFilterSql = promoFilters.join('\n         ');

    const rows = await this.dataSource.query(
      `WITH claims AS (
         SELECT upc.promotion_id,
                COUNT(*)::int                              AS total_claims,
                COUNT(DISTINCT upc.user_id)::int           AS unique_players,
                COALESCE(SUM(upc.bonus_amount), 0)::numeric AS total_bonus
         FROM user_promotion_claims upc
         WHERE upc.claimed_at >= ${startSql}
           AND upc.claimed_at <  ${endSql}
         GROUP BY upc.promotion_id
       ),
       deps AS (
         SELECT d.promotion_id,
                COALESCE(SUM(d.amount), 0)::numeric AS total_deposit
         FROM deposits d
         WHERE d.status = 'APPROVED'
           AND d.created_at >= ${startSql}
           AND d.created_at <  ${endSql}
           AND d.promotion_id IS NOT NULL
         GROUP BY d.promotion_id
       ),
       bets_agg AS (
         SELECT upc.promotion_id,
                COALESCE(SUM(b.bet_amount), 0)::numeric AS total_wagered,
                COALESCE(SUM(
                  CASE
                    WHEN b.result_status = 'WON'  THEN (b.potential_payout - b.bet_amount)
                    WHEN b.result_status = 'LOST' THEN -b.bet_amount
                    ELSE 0
                  END
                ), 0)::numeric AS net_winloss
         FROM user_promotion_claims upc
         JOIN bets b ON b.user_id = upc.user_id
         WHERE upc.claimed_at >= ${startSql}
           AND upc.claimed_at <  ${endSql}
           AND b.placed_at >= upc.claimed_at
           AND (upc.completed_at IS NULL OR b.placed_at <= upc.completed_at)
           AND b.result_status IN ('WON','LOST')
         GROUP BY upc.promotion_id
       )
       SELECT p.id, p.title, p.code, p.kind, p.is_active, p.currency,
              p.max_bonus_pool                AS max_total_limit,
              p.created_at                    AS applied_date,
              COALESCE(c.total_claims, 0)     AS total_claims,
              COALESCE(c.unique_players, 0)   AS unique_players,
              COALESCE(c.total_bonus, 0)      AS total_bonus,
              COALESCE(d.total_deposit, 0)    AS total_deposit,
              COALESCE(bt.total_wagered, 0)   AS total_wagered,
              COALESCE(bt.net_winloss, 0)     AS total_win_loss,
              CASE WHEN COALESCE(c.unique_players, 0) > 0
                   THEN ROUND((c.total_claims::numeric / c.unique_players), 2)
                   ELSE 0
              END AS claim_frequency_velocity
       FROM promotions p
       LEFT JOIN claims   c  ON c.promotion_id  = p.id
       LEFT JOIN deps     d  ON d.promotion_id  = p.id
       LEFT JOIN bets_agg bt ON bt.promotion_id = p.id
       WHERE p.currency = $1
         ${promoFilterSql}
       ORDER BY total_bonus DESC, p.id DESC`,
      [currency, ...params],
    );

    // ── Dashboard cards: company-wide totals for the same filters/range ──
    //   Money/claims sums come straight from the grid rows (already filtered
    //   & aggregated per promo). unique_claimers needs a distinct count.
    const num = (v: any) => parseFloat(v ?? '0') || 0;
    const totalDeposits = rows.reduce((s: number, r: any) => s + num(r.total_deposit), 0);
    const totalBonus    = rows.reduce((s: number, r: any) => s + num(r.total_bonus), 0);
    const totalWagered  = rows.reduce((s: number, r: any) => s + num(r.total_wagered), 0);
    const netWinLoss    = rows.reduce((s: number, r: any) => s + num(r.total_win_loss), 0);
    const totalClaims   = rows.reduce((s: number, r: any) => s + Number(r.total_claims ?? 0), 0);

    const uniqRows = await this.dataSource.query(
      `SELECT COUNT(DISTINCT upc.user_id)::int AS unique_claimers
       FROM user_promotion_claims upc
       JOIN promotions p ON p.id = upc.promotion_id
       WHERE upc.claimed_at >= ${startSql}
         AND upc.claimed_at <  ${endSql}
         AND p.currency = $1
         ${promoFilterSql}`,
      [currency, ...params],
    );

    const summary = {
      total_deposits:    totalDeposits,    // card: TOTAL DEPOSITS
      total_bonus_issued: totalBonus,      // card: TOTAL BONUS ISSUED
      net_win_loss:      netWinLoss,       // card: NET WIN / LOSS
      total_wagered:     totalWagered,
      players_engaged:   totalClaims,      // card: PLAYERS ENGAGED (participation count)
      unique_claimers:   uniqRows[0]?.unique_claimers ?? 0,
    };

    return { range: this.describeRange(q), currency, summary, data: rows };
  }

  // ═════════════════════════════════════════════════════════════
  // DRILL-DOWN
  // ═════════════════════════════════════════════════════════════
  async drilldown(promotionId: number, q: StatsQueryDto) {
    const { startSql, endSql, params } = this.buildRange(q);

    const daily = await this.dataSource.query(
      `SELECT DATE_TRUNC('day', upc.claimed_at) AS day,
              COUNT(*)::int AS claims,
              COUNT(DISTINCT upc.user_id)::int AS unique_players,
              COALESCE(SUM(upc.bonus_amount), 0)::numeric AS bonus_issued
       FROM user_promotion_claims upc
       WHERE upc.promotion_id = $1
         AND upc.claimed_at >= ${startSql}
         AND upc.claimed_at <  ${endSql}
       GROUP BY 1
       ORDER BY 1 ASC`,
      [promotionId, ...params],
    );

    const byStatus = await this.dataSource.query(
      `SELECT status, COUNT(*)::int AS n
       FROM user_promotion_claims
       WHERE promotion_id = $1
         AND claimed_at >= ${startSql}
         AND claimed_at <  ${endSql}
       GROUP BY status`,
      [promotionId, ...params],
    );

    const topClaimers = await this.dataSource.query(
      `SELECT upc.user_id, u.username, u.user_code,
              COUNT(*)::int AS claims,
              COALESCE(SUM(upc.bonus_amount), 0)::numeric AS bonus_received
       FROM user_promotion_claims upc
       JOIN users u ON u.id = upc.user_id
       WHERE upc.promotion_id = $1
         AND upc.claimed_at >= ${startSql}
         AND upc.claimed_at <  ${endSql}
       GROUP BY upc.user_id, u.username, u.user_code
       ORDER BY claims DESC, bonus_received DESC
       LIMIT 20`,
      [promotionId, ...params],
    );

    const betSummary = await this.dataSource.query(
      `SELECT
         COUNT(*)::int                                            AS bets_settled,
         COUNT(*) FILTER (WHERE b.result_status = 'WON')::int     AS bets_won,
         COUNT(*) FILTER (WHERE b.result_status = 'LOST')::int    AS bets_lost,
         COALESCE(SUM(b.bet_amount), 0)::numeric                  AS total_wagered,
         COALESCE(SUM(
           CASE
             WHEN b.result_status = 'WON'  THEN (b.potential_payout - b.bet_amount)
             WHEN b.result_status = 'LOST' THEN -b.bet_amount
             ELSE 0
           END
         ), 0)::numeric                                           AS net_player_winloss
       FROM user_promotion_claims upc
       JOIN bets b ON b.user_id = upc.user_id
       WHERE upc.promotion_id = $1
         AND upc.claimed_at >= ${startSql}
         AND upc.claimed_at <  ${endSql}
         AND b.placed_at >= upc.claimed_at
         AND (upc.completed_at IS NULL OR b.placed_at <= upc.completed_at)
         AND b.result_status IN ('WON','LOST')`,
      [promotionId, ...params],
    );

    return {
      promotionId,
      range: this.describeRange(q),
      daily,
      by_status: byStatus,
      top_claimers: topClaimers,
      bet_summary: betSummary[0] ?? {
        bets_settled: 0, bets_won: 0, bets_lost: 0,
        total_wagered: 0, net_player_winloss: 0,
      },
    };
  }

  // ═════════════════════════════════════════════════════════════
  // RANGE HELPERS
  // ═════════════════════════════════════════════════════════════
  private buildRange(q: StatsQueryDto): { startSql: string; endSql: string; params: any[] } {
    const range: QuickRange = q.range ?? 'TODAY';
    const offset = this.paramOffset(q);

    switch (range) {
      case 'TODAY':      return { startSql: `CURRENT_DATE`, endSql: `CURRENT_DATE + INTERVAL '1 day'`, params: [] };
      case 'YESTERDAY':  return { startSql: `CURRENT_DATE - INTERVAL '1 day'`, endSql: `CURRENT_DATE`, params: [] };
      case 'THIS_WEEK':  return { startSql: `DATE_TRUNC('week', CURRENT_DATE)`, endSql: `DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'`, params: [] };
      case 'LAST_WEEK':  return { startSql: `DATE_TRUNC('week', CURRENT_DATE) - INTERVAL '7 days'`, endSql: `DATE_TRUNC('week', CURRENT_DATE)`, params: [] };
      case 'THIS_MONTH': return { startSql: `DATE_TRUNC('month', CURRENT_DATE)`, endSql: `DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'`, params: [] };
      case 'LAST_MONTH': return { startSql: `DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'`, endSql: `DATE_TRUNC('month', CURRENT_DATE)`, params: [] };
      case 'CUSTOM': {
        if (!q.startDate || !q.endDate) {
          return { startSql: `CURRENT_DATE`, endSql: `CURRENT_DATE + INTERVAL '1 day'`, params: [] };
        }
        return {
          startSql: `$${offset + 1}::timestamptz`,
          endSql:   `$${offset + 2}::timestamptz`,
          params:   [q.startDate, q.endDate],
        };
      }
      default: return { startSql: `CURRENT_DATE`, endSql: `CURRENT_DATE + INTERVAL '1 day'`, params: [] };
    }
  }

  private paramOffset(_q: StatsQueryDto): number { return 1; }

  private describeRange(q: StatsQueryDto): string {
    if (q.range === 'CUSTOM' && q.startDate && q.endDate) {
      return `${q.startDate} → ${q.endDate}`;
    }
    return q.range ?? 'TODAY';
  }
}
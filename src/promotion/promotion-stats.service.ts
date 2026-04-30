// src/promotion/promotion-stats.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StatsQueryDto } from './dto/promotion-stats.dto';

/**
 * Single Responsibility: read-only analytics for promotions.
 *
 * Pure aggregation against:
 *   - promotions (engine config + counters)
 *   - user_promotion_claims (who claimed what)
 *   - deposits (money brought in via claims)
 *   - financial_ledger (win payouts to claimants)
 *
 * Date range: convention is `from` is inclusive, `to` is exclusive
 * (so "Today" = [00:00 today, 00:00 tomorrow)).
 */
@Injectable()
export class PromotionStatsService {
  constructor(private dataSource: DataSource) {}

  // ═════════════════════════════════════════════════════════════
  // PER-PROMOTION DETAIL
  // ═════════════════════════════════════════════════════════════
  async getPromotionStats(promotionId: number, q: StatsQueryDto) {
    const promo = await this.dataSource.query(
      `SELECT id, code, title, kind, currency,
              max_bonus_pool, bonus_paid_total, uses_count,
              max_uses_global, max_uses_per_user, is_active,
              starts_at, ends_at, created_at
       FROM promotions WHERE id = $1`,
      [promotionId],
    );
    if (!promo.length) throw new NotFoundException('Promotion not found');

    const { fromDate, toDate } = this.resolveDateRange(q);

    // 1. Claim aggregates
    const claimAgg = await this.dataSource.query(
      `SELECT
          COUNT(DISTINCT user_id)::int                              AS unique_players,
          COUNT(*)::int                                             AS total_claims,
          COALESCE(SUM(bonus_amount), 0)::numeric                   AS total_bonus,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int            AS active_claims,
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int         AS completed_claims,
          COUNT(*) FILTER (WHERE status = 'CANCELLED')::int         AS cancelled_claims
       FROM user_promotion_claims
       WHERE promotion_id = $1
         AND claimed_at >= $2 AND claimed_at < $3`,
      [promotionId, fromDate, toDate],
    );

    // 2. Deposit total — only deposits linked to this promo's claims
    const depositAgg = await this.dataSource.query(
      `SELECT COALESCE(SUM(d.amount), 0)::numeric AS total_deposit
       FROM user_promotion_claims upc
       JOIN deposits d ON d.id = upc.deposit_id
       WHERE upc.promotion_id = $1
         AND d.status = 'APPROVED'
         AND upc.claimed_at >= $2 AND upc.claimed_at < $3`,
      [promotionId, fromDate, toDate],
    );

    // 3. Win payouts to users who used this promo
    //    (subset that affects company P&L for this promo)
    const winAgg = await this.dataSource.query(
      `SELECT COALESCE(SUM(fl.amount), 0)::numeric AS total_win_payouts
       FROM financial_ledger fl
       WHERE fl.entry_type = 'WIN_CREDIT'
         AND fl.created_at >= $2 AND fl.created_at < $3
         AND fl.user_id IN (
           SELECT DISTINCT user_id FROM user_promotion_claims
           WHERE promotion_id = $1
             AND claimed_at >= $2 AND claimed_at < $3
         )`,
      [promotionId, fromDate, toDate],
    );

    const totalDeposit = parseFloat(depositAgg[0].total_deposit);
    const totalBonus = parseFloat(claimAgg[0].total_bonus);
    const totalWin = parseFloat(winAgg[0].total_win_payouts);
    const netPL = totalDeposit - totalBonus - totalWin;

    return {
      promotion: promo[0],
      dateRange: { from: fromDate, to: toDate, preset: q.preset ?? null },
      claims: {
        unique_players: claimAgg[0].unique_players,
        total_claims: claimAgg[0].total_claims,
        active: claimAgg[0].active_claims,
        completed: claimAgg[0].completed_claims,
        cancelled: claimAgg[0].cancelled_claims,
      },
      financials: {
        total_deposit: totalDeposit,
        total_bonus: totalBonus,
        total_win_payouts: totalWin,
        net_pl: netPL,
        is_profitable: netPL >= 0,
      },
      pool: {
        max_bonus_pool: promo[0].max_bonus_pool ? parseFloat(promo[0].max_bonus_pool) : null,
        bonus_paid_total: parseFloat(promo[0].bonus_paid_total),
        pool_remaining: promo[0].max_bonus_pool
          ? parseFloat(promo[0].max_bonus_pool) - parseFloat(promo[0].bonus_paid_total)
          : null,
        pool_used_pct: promo[0].max_bonus_pool
          ? Math.round(
              (parseFloat(promo[0].bonus_paid_total) / parseFloat(promo[0].max_bonus_pool)) *
                100,
            )
          : null,
      },
      uses: {
        uses_count: promo[0].uses_count,
        max_uses_global: promo[0].max_uses_global,
        max_uses_per_user: promo[0].max_uses_per_user,
      },
    };
  }

  // ═════════════════════════════════════════════════════════════
  // SUMMARY TABLE — matches screenshot 5 layout
  //   One row per promotion, aggregated across the date range.
  //
  //   Note: $1=fromDate, $2=toDate are reused by all CTEs.
  //   Postgres lets you reference the same placeholder multiple times.
  // ═════════════════════════════════════════════════════════════
  async getStatsSummary(q: StatsQueryDto) {
    const { fromDate, toDate } = this.resolveDateRange(q);

    const where: string[] = ['1=1'];
    const extraParams: any[] = [];
    let i = 3; // $1=fromDate, $2=toDate already used

    if (q.currency) {
      where.push(`p.currency = $${i++}`);
      extraParams.push(q.currency);
    }
    if (q.status === 'ACTIVE') where.push('p.is_active = TRUE');
    if (q.status === 'INACTIVE') where.push('p.is_active = FALSE');

    const rows = await this.dataSource.query(
      `WITH claim_stats AS (
         SELECT
           upc.promotion_id,
           COUNT(DISTINCT upc.user_id)::int                AS unique_players,
           COUNT(*)::int                                   AS total_claims,
           COALESCE(SUM(upc.bonus_amount), 0)::numeric     AS total_bonus
         FROM user_promotion_claims upc
         WHERE upc.claimed_at >= $1 AND upc.claimed_at < $2
         GROUP BY upc.promotion_id
       ),
       deposit_stats AS (
         SELECT
           upc.promotion_id,
           COALESCE(SUM(d.amount), 0)::numeric AS total_deposit
         FROM user_promotion_claims upc
         JOIN deposits d ON d.id = upc.deposit_id
         WHERE d.status = 'APPROVED'
           AND upc.claimed_at >= $1 AND upc.claimed_at < $2
         GROUP BY upc.promotion_id
       ),
       win_stats AS (
         SELECT
           upc.promotion_id,
           COALESCE(SUM(fl.amount), 0)::numeric AS total_win_payouts
         FROM user_promotion_claims upc
         JOIN financial_ledger fl
           ON fl.user_id = upc.user_id
          AND fl.entry_type = 'WIN_CREDIT'
          AND fl.created_at >= $1 AND fl.created_at < $2
         WHERE upc.claimed_at >= $1 AND upc.claimed_at < $2
         GROUP BY upc.promotion_id
       )
       SELECT
         p.id, p.code, p.title, p.kind, p.currency, p.is_active,
         p.max_bonus_pool, p.bonus_paid_total, p.uses_count,
         p.max_uses_global,
         COALESCE(cs.unique_players, 0)    AS unique_players,
         COALESCE(cs.total_claims, 0)      AS total_claims,
         COALESCE(ds.total_deposit, 0)     AS total_deposit,
         COALESCE(cs.total_bonus, 0)       AS total_bonus,
         COALESCE(ws.total_win_payouts, 0) AS total_win_payouts,
         (
           COALESCE(ds.total_deposit, 0)
           - COALESCE(cs.total_bonus, 0)
           - COALESCE(ws.total_win_payouts, 0)
         ) AS net_pl
       FROM promotions p
       LEFT JOIN claim_stats   cs ON cs.promotion_id = p.id
       LEFT JOIN deposit_stats ds ON ds.promotion_id = p.id
       LEFT JOIN win_stats     ws ON ws.promotion_id = p.id
       WHERE ${where.join(' AND ')}
       ORDER BY p.id DESC`,
      [fromDate, toDate, ...extraParams],
    );

    // Cast numerics to JS numbers for cleaner JSON output
    const data = rows.map((r: any) => ({
      id: Number(r.id),
      code: r.code,
      title: r.title,
      kind: r.kind,
      currency: r.currency,
      is_active: r.is_active,
      promotion_max_total: r.max_bonus_pool ? parseFloat(r.max_bonus_pool) : null,
      uses_count: Number(r.uses_count),
      max_uses_global: r.max_uses_global ? Number(r.max_uses_global) : null,
      unique_players: Number(r.unique_players),
      total_claims: Number(r.total_claims),
      total_deposit: parseFloat(r.total_deposit),
      total_bonus: parseFloat(r.total_bonus),
      total_win_payouts: parseFloat(r.total_win_payouts),
      net_pl: parseFloat(r.net_pl),
      bonus_paid_total: parseFloat(r.bonus_paid_total),
    }));

    return {
      dateRange: { from: fromDate, to: toDate, preset: q.preset ?? null },
      filters: { currency: q.currency, status: q.status ?? 'ALL' },
      count: data.length,
      data,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // OVERVIEW — single-row company-wide totals
  //   For an admin dashboard "promotions cost us X this month"
  // ═════════════════════════════════════════════════════════════
  async getOverview(q: StatsQueryDto) {
    const { fromDate, toDate } = this.resolveDateRange(q);

    const result = await this.dataSource.query(
      `SELECT
         COUNT(DISTINCT promotion_id)::int           AS active_promotions,
         COUNT(DISTINCT user_id)::int                AS unique_claimers,
         COUNT(*)::int                               AS total_claims,
         COALESCE(SUM(bonus_amount), 0)::numeric     AS total_bonus_paid
       FROM user_promotion_claims
       WHERE claimed_at >= $1 AND claimed_at < $2`,
      [fromDate, toDate],
    );

    const depositResult = await this.dataSource.query(
      `SELECT COALESCE(SUM(d.amount), 0)::numeric AS total_deposit_via_promos
       FROM user_promotion_claims upc
       JOIN deposits d ON d.id = upc.deposit_id
       WHERE d.status = 'APPROVED'
         AND upc.claimed_at >= $1 AND upc.claimed_at < $2`,
      [fromDate, toDate],
    );

    return {
      dateRange: { from: fromDate, to: toDate, preset: q.preset ?? null },
      active_promotions: result[0].active_promotions,
      unique_claimers: result[0].unique_claimers,
      total_claims: result[0].total_claims,
      total_bonus_paid: parseFloat(result[0].total_bonus_paid),
      total_deposit_via_promos: parseFloat(depositResult[0].total_deposit_via_promos),
    };
  }

  // ═════════════════════════════════════════════════════════════
  // PRIVATE: date range resolver
  // ═════════════════════════════════════════════════════════════
  private resolveDateRange(q: StatsQueryDto): { fromDate: string; toDate: string } {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let fromDate: Date;
    let toDate: Date;

    switch (q.preset) {
      case 'TODAY':
        fromDate = today;
        toDate = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        break;
      case 'YESTERDAY':
        fromDate = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        toDate = today;
        break;
      case 'THIS_WEEK': {
        // Monday = 0, Sunday = 6 (configurable based on locale)
        const dow = (today.getDay() + 6) % 7;
        fromDate = new Date(today.getTime() - dow * 24 * 60 * 60 * 1000);
        toDate = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        break;
      }
      case 'LAST_WEEK': {
        const dow = (today.getDay() + 6) % 7;
        toDate = new Date(today.getTime() - dow * 24 * 60 * 60 * 1000);
        fromDate = new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      }
      case 'THIS_MONTH':
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
        toDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        break;
      case 'LAST_MONTH':
        fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        toDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'CUSTOM':
      default:
        if (q.from && q.to) {
          fromDate = new Date(q.from);
          toDate = new Date(q.to);
          if (toDate < fromDate) {
            throw new BadRequestException('to must be >= from');
          }
        } else {
          // No preset, no explicit dates → default to last 30 days
          fromDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
          toDate = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        }
        break;
    }

    return {
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
    };
  }
}
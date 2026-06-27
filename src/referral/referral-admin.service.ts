import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SHARED_DEVICE_OR_IP_SQL, describeShared } from './referral-fraud.util';
import { ReferralEngineService } from './referral-engine.service';

const CONVERTED = `('COMPLETED','BONUS_CLEARING','DONE')`;
const BONUS_PAID = `('BONUS_CLEARING','DONE')`;
const ACTIVEISH = `('PENDING','ACTIVE')`;

// Config keys an admin is allowed to change via the API.
const EDITABLE_CONFIG = new Set([
  'bonus_amount',
  'wagering_multiplier',
  'referrer_deposit_min',
  'referee_deposit_min',
  'referrer_turnover_min',
  'referee_turnover_min',
  'window_hours',
]);

/**
 * Admin dashboard + management for the refer-a-friend system.
 * Read-only KPIs over friend_referrals / referral_bonus_wagering /
 * referral_status, plus disqualify + config editing.
 */
@Injectable()
export class ReferralAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly engine: ReferralEngineService,
  ) {}

  // ── POST /admin/referrals/recompute  (and /:id/recompute) ──
  //   Re-run completion for all (or one) PENDING/ACTIVE referral. Credits any
  //   whose targets are all met but were never triggered by a deposit/bet
  //   event (e.g. 0-minimum rules). Idempotent — already-paid rows are skipped.
  async recompute(referralId?: number) {
    if (referralId !== undefined) {
      const [r] = await this.dataSource.query(
        `SELECT id FROM friend_referrals WHERE id = $1`,
        [referralId],
      );
      if (!r) throw new NotFoundException('Referral not found');
    }
    return this.engine.recompute(referralId);
  }

  // Optional started_at date window for the referral-based KPIs.
  private dateClause(from?: string, to?: string) {
    const conds: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (from) {
      conds.push(`started_at >= $${i++}`);
      params.push(from);
    }
    if (to) {
      conds.push(`started_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(to);
    }
    return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
  }

  // ── GET /admin/referrals/stats — every KPI the dashboard needs ──
  async getStats(from?: string, to?: string) {
    const { where, params } = this.dateClause(from, to);

    const [summary] = await this.dataSource.query(
      `SELECT
         COUNT(*)::int                                                       AS total,
         COUNT(DISTINCT referrer_user_id)::int                               AS total_referrers,
         COUNT(*) FILTER (WHERE status IN ${ACTIVEISH})::int                 AS active_referrals,
         COUNT(*) FILTER (WHERE status = 'EXPIRED')::int                     AS expired,
         COUNT(*) FILTER (WHERE status IN ${CONVERTED})::int                 AS converted,
         AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 3600.0)
           FILTER (WHERE completed_at IS NOT NULL)                           AS avg_hours_to_complete
       FROM friend_referrals ${where}`,
      params,
    );

    const [{ total_bonuses_paid }] = await this.dataSource.query(
      `SELECT COALESCE(SUM(bonus_amount), 0)::numeric AS total_bonuses_paid
         FROM referral_bonus_wagering WHERE bonus_credited_at IS NOT NULL`,
    );

    const [funnel] = await this.dataSource.query(
      `SELECT
         COUNT(*)::int                                                  AS invited,
         COUNT(*) FILTER (WHERE referee_deposit_met)::int               AS referee_deposited,
         COUNT(*) FILTER (WHERE referee_turnover_total > 0)::int        AS turnover_started,
         COUNT(*) FILTER (WHERE status IN ${CONVERTED})::int            AS all_targets_met,
         COUNT(*) FILTER (WHERE status IN ${BONUS_PAID})::int           AS bonus_paid
       FROM friend_referrals ${where}`,
      params,
    );

    const completions = await this.dataSource.query(
      `SELECT TO_CHAR(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
         FROM friend_referrals
        WHERE status IN ${CONVERTED} AND completed_at >= NOW() - INTERVAL '30 days'
        GROUP BY day`,
    );
    const expirations = await this.dataSource.query(
      `SELECT TO_CHAR(expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
         FROM friend_referrals
        WHERE status = 'EXPIRED' AND expired_at >= NOW() - INTERVAL '30 days'
        GROUP BY day`,
    );
    const trend = new Map<string, { date: string; completed: number; expired: number }>();
    for (const r of completions)
      trend.set(r.day, { date: r.day, completed: r.n, expired: 0 });
    for (const r of expirations) {
      const e = trend.get(r.day) ?? { date: r.day, completed: 0, expired: 0 };
      e.expired = r.n;
      trend.set(r.day, e);
    }
    const dailyTrend = [...trend.values()].sort((a, b) => a.date.localeCompare(b.date));

    const dist = await this.dataSource.query(
      `SELECT
         CASE
           WHEN referee_turnover_total < 1000 THEN 'lt_1000'
           WHEN referee_turnover_total < 3000 THEN '1000_3000'
           WHEN referee_turnover_total < 4500 THEN '3000_4500'
           ELSE 'completed'
         END AS bucket,
         COUNT(*)::int AS count
       FROM friend_referrals
       WHERE status IN ${ACTIVEISH}
       GROUP BY bucket`,
    );

    const wagering = await this.dataSource.query(
      `SELECT
         CASE
           WHEN is_cleared THEN 'cleared'
           WHEN wagering_completed > 0 THEN 'in_progress'
           ELSE 'not_started'
         END AS state,
         COUNT(*)::int AS count
       FROM referral_bonus_wagering
       GROUP BY state`,
    );

    const total = summary?.total ?? 0;
    const expired = summary?.expired ?? 0;
    const converted = summary?.converted ?? 0;
    const pct = (n: number) => (total ? Number(((n / total) * 100).toFixed(2)) : 0);

    return {
      summary: {
        totalReferrers: summary?.total_referrers ?? 0,
        activeReferrals: summary?.active_referrals ?? 0,
        totalReferrals: total,
        totalBonusesPaid: Number(total_bonuses_paid ?? 0),
        expiryRate: pct(expired),
        conversionRate: pct(converted),
        avgHoursToComplete:
          summary?.avg_hours_to_complete == null
            ? null
            : Number(Number(summary.avg_hours_to_complete).toFixed(1)),
      },
      funnel: [
        { stage: 'Invited', count: funnel?.invited ?? 0 },
        { stage: 'Referee deposited', count: funnel?.referee_deposited ?? 0 },
        { stage: 'Turnover started', count: funnel?.turnover_started ?? 0 },
        { stage: 'All targets met', count: funnel?.all_targets_met ?? 0 },
        { stage: 'Bonus paid', count: funnel?.bonus_paid ?? 0 },
      ],
      dailyTrend,
      refereeTurnoverDistribution: dist.map((d: any) => ({ bucket: d.bucket, count: d.count })),
      wageringClearance: wagering.map((w: any) => ({ state: w.state, count: w.count })),
      window: { from: from ?? null, to: to ?? null },
    };
  }

  // ── GET /admin/referrals — paginated list ──
  async listReferrals(q: {
    status?: string;
    referrerId?: number;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const conds: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (q.status) {
      conds.push(`r.status = $${i++}`);
      params.push(q.status.toUpperCase());
    }
    if (q.referrerId !== undefined) {
      conds.push(`r.referrer_user_id = $${i++}`);
      params.push(q.referrerId);
    }
    if (q.from) {
      conds.push(`r.started_at >= $${i++}`);
      params.push(q.from);
    }
    if (q.to) {
      conds.push(`r.started_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(q.to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = await this.dataSource.query(
      `SELECT r.id, r.status, r.started_at, r.expires_at, r.completed_at, r.expired_at,
              r.referrer_user_id, ru.username AS referrer_username,
              r.referee_user_id,  eu.username AS referee_username,
              r.referrer_deposit_met, r.referee_deposit_met,
              r.referrer_turnover_met, r.referee_turnover_met,
              r.referee_deposit_total, r.referee_turnover_total,
              r.config_bonus_amount, r.disqualification_reason
         FROM friend_referrals r
         JOIN users ru ON ru.id = r.referrer_user_id
         JOIN users eu ON eu.id = r.referee_user_id
         ${where}
         ORDER BY r.started_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
      [...params, limit, offset],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM friend_referrals r ${where}`,
      params,
    );

    return { data: rows, page, limit, total, totalPages: Math.ceil(total / limit) || 0 };
  }

  // ════════════════════════════════════════════════════════════════════════
  // REFERRER SEARCH (top-level table)
  //   Filters: currency, username, referralCode, date range (started_at).
  //   Returns one row per referrer who made ≥1 matching referral:
  //   { currency, username, referralCode, referralCount }.
  //   NOTE: there is no per-user currency column in the schema (BDT-only
  //   platform), so currency is the constant 'BDT' and the filter is a BDT
  //   pass-through — a non-BDT value yields no rows.
  // ════════════════════════════════════════════════════════════════════════
  async searchReferrers(q: {
    currency?: string;
    username?: string;
    referralCode?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    // Single-currency platform: a non-BDT currency request matches nothing.
    if (q.currency && q.currency.trim().toUpperCase() !== 'BDT') {
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }

    const conds: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (q.username?.trim()) {
      conds.push(`ru.username ILIKE $${i++}`);
      params.push(`%${q.username.trim()}%`);
    }
    if (q.referralCode?.trim()) {
      conds.push(`ru.referral_code ILIKE $${i++}`);
      params.push(`%${q.referralCode.trim()}%`);
    }
    if (q.from) {
      conds.push(`r.started_at >= $${i++}`);
      params.push(q.from);
    }
    if (q.to) {
      conds.push(`r.started_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(q.to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = await this.dataSource.query(
      `SELECT 'BDT'                  AS currency,
              ru.id                  AS referrer_user_id,
              ru.username,
              ru.user_code,
              ru.referral_code,
              COUNT(r.id)::int       AS referral_count,
              COUNT(*) OVER()::int   AS total_count
         FROM friend_referrals r
         JOIN users ru ON ru.id = r.referrer_user_id
         ${where}
         GROUP BY ru.id, ru.username, ru.user_code, ru.referral_code
         ORDER BY referral_count DESC, ru.username ASC
         LIMIT $${i++} OFFSET $${i++}`,
      [...params, limit, offset],
    );

    const total = rows.length ? Number(rows[0].total_count) : 0;
    const data = rows.map((r: any) => ({
      currency:       r.currency,
      referrerUserId: Number(r.referrer_user_id),
      username:       r.username,
      userCode:       r.user_code,
      referralCode:   r.referral_code,
      referralCount:  Number(r.referral_count),
    }));

    return { data, page, limit, total, totalPages: Math.ceil(total / limit) || 0 };
  }

  // ════════════════════════════════════════════════════════════════════════
  // REFERRER DRILL-DOWN (clicking the referral count)
  //   Lists the people a referrer referred: name, registration date/time,
  //   bonus creation date/time (completed_at), and status mapped to the
  //   admin's vocabulary: Approved / Disqualified / Expired (Pending while
  //   still in progress). Same date range as the search so it matches the count.
  // ════════════════════════════════════════════════════════════════════════
  async getReferralDetails(
    referrerUserId: number,
    q?: { from?: string; to?: string },
  ) {
    const conds: string[] = ['r.referrer_user_id = $1'];
    const params: any[] = [referrerUserId];
    let i = 2;
    if (q?.from) {
      conds.push(`r.started_at >= $${i++}`);
      params.push(q.from);
    }
    if (q?.to) {
      conds.push(`r.started_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(q.to);
    }
    const where = `WHERE ${conds.join(' AND ')}`;

    const rows = await this.dataSource.query(
      `SELECT r.id,
              eu.id          AS referee_user_id,
              eu.full_name   AS name,
              eu.username    AS referee_username,
              eu.user_code   AS referee_user_code,
              eu.created_at  AS registered_at,
              r.completed_at AS bonus_created_at,
              r.status       AS raw_status,
              CASE
                WHEN r.status IN ('COMPLETED','BONUS_CLEARING','DONE') THEN 'Approved'
                WHEN r.status = 'DISQUALIFIED'                         THEN 'Disqualified'
                WHEN r.status = 'EXPIRED'                              THEN 'Expired'
                ELSE 'Pending'
              END            AS status,
              r.disqualification_reason
         FROM friend_referrals r
         JOIN users eu ON eu.id = r.referee_user_id
         ${where}
         ORDER BY r.started_at DESC`,
      params,
    );

    return rows.map((r: any) => ({
      referralId:             Number(r.id),
      refereeUserId:          Number(r.referee_user_id),
      name:                   r.name,
      refereeUsername:        r.referee_username,
      refereeUserCode:        r.referee_user_code,
      registeredAt:           r.registered_at,     // registration date & time
      bonusCreatedAt:         r.bonus_created_at,   // bonus creation date & time
      status:                 r.status,            // Approved | Disqualified | Expired | Pending
      rawStatus:              r.raw_status,
      disqualificationReason: r.disqualification_reason,
    }));
  }

  // ── GET /admin/referrals/leaderboard — top affiliates ──
  async getLeaderboard(sort = 'conversions', limit = 20) {
    const orderBy =
      sort === 'bonus'
        ? 'rs.total_bonus_earned'
        : sort === 'sent'
          ? 'rs.total_referrals_sent'
          : 'rs.total_referrals_converted';
    const lim = Math.min(Math.max(limit, 1), 100);

    const rows = await this.dataSource.query(
      `SELECT u.id, u.username, u.user_code, u.account_status,
              rs.total_referrals_sent      AS sent,
              rs.total_referrals_converted AS conversions,
              rs.total_bonus_earned        AS bonus_earned,
              rs.referrer_turnover_unlocked
         FROM referral_status rs
         JOIN users u ON u.id = rs.user_id
        WHERE rs.total_referrals_sent > 0
        ORDER BY ${orderBy} DESC, rs.updated_at DESC
        LIMIT $1`,
      [lim],
    );

    return rows.map((r: any) => {
      const sent = Number(r.sent ?? 0);
      const conv = Number(r.conversions ?? 0);
      return {
        userId: Number(r.id),
        username: r.username,
        userCode: r.user_code,
        accountStatus: r.account_status,
        totalReferralsSent: sent,
        conversions: conv,
        conversionRate: sent ? Number(((conv / sent) * 100).toFixed(2)) : 0,
        totalBonusEarned: Number(r.bonus_earned ?? 0),
        turnoverUnlocked: !!r.referrer_turnover_unlocked,
      };
    });
  }

  // ── GET /admin/referrals/tree/:userId — recursive invite tree ──
  async getTree(userId: number, maxDepth = 5) {
    const rows = await this.dataSource.query(
      `WITH RECURSIVE tree AS (
         SELECT id, username, user_code, referred_by_user_id, account_status, 0 AS depth
           FROM users WHERE id = $1
         UNION ALL
         SELECT u.id, u.username, u.user_code, u.referred_by_user_id, u.account_status, t.depth + 1
           FROM users u
           JOIN tree t ON u.referred_by_user_id = t.id
          WHERE t.depth < $2
       )
       SELECT * FROM tree ORDER BY depth, id`,
      [userId, maxDepth],
    );
    if (!rows.length) throw new NotFoundException('User not found');
    return {
      rootUserId: userId,
      maxDepth,
      total: rows.length - 1, // exclude the root
      nodes: rows.map((r: any) => ({
        userId: Number(r.id),
        username: r.username,
        userCode: r.user_code,
        accountStatus: r.account_status,
        referredBy: r.referred_by_user_id == null ? null : Number(r.referred_by_user_id),
        depth: r.depth,
      })),
    };
  }

  // ── PATCH /admin/referrals/:id/disqualify ──
  async disqualify(referralId: number, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('reason is required');
    const [r] = await this.dataSource.query(
      `SELECT id, status FROM friend_referrals WHERE id = $1`,
      [referralId],
    );
    if (!r) throw new NotFoundException('Referral not found');
    if (r.status === 'DONE')
      throw new BadRequestException('Cannot disqualify a DONE referral');

    await this.dataSource.query(
      `UPDATE friend_referrals
          SET status = 'DISQUALIFIED', disqualification_reason = $2, updated_at = NOW()
        WHERE id = $1`,
      [referralId, reason.trim()],
    );
    // NOTE: does not claw back an already-credited bonus — flagged for review.
    return { message: 'Referral disqualified', referralId, previousStatus: r.status };
  }

  // ── POST /admin/referrals/fraud-scan ──
  //   Scans active (PENDING/ACTIVE) referrals for referrer/referee sharing a
  //   device fingerprint or IP and auto-disqualifies the matches. dryRun=true
  //   reports without writing.
  async fraudScan(dryRun = false) {
    const refs = await this.dataSource.query(
      `SELECT r.id, r.referrer_user_id, r.referee_user_id,
              ru.username AS referrer_username, eu.username AS referee_username
         FROM friend_referrals r
         JOIN users ru ON ru.id = r.referrer_user_id
         JOIN users eu ON eu.id = r.referee_user_id
        WHERE r.status IN ('PENDING','ACTIVE')`,
    );

    const flagged: any[] = [];
    for (const r of refs) {
      const [row] = await this.dataSource.query(SHARED_DEVICE_OR_IP_SQL, [
        r.referrer_user_id,
        r.referee_user_id,
      ]);
      const f = describeShared(row);
      if (!f.shared) continue;

      const reason = `Auto fraud scan: ${f.reason}`;
      if (!dryRun) {
        await this.dataSource.query(
          `UPDATE friend_referrals
              SET status = 'DISQUALIFIED', disqualification_reason = $2, updated_at = NOW()
            WHERE id = $1 AND status IN ('PENDING','ACTIVE')`,
          [r.id, reason],
        );
      }
      flagged.push({
        referralId: Number(r.id),
        referrer: { id: Number(r.referrer_user_id), username: r.referrer_username },
        referee: { id: Number(r.referee_user_id), username: r.referee_username },
        reason,
      });
    }

    return {
      dryRun,
      scanned: refs.length,
      disqualified: dryRun ? 0 : flagged.length,
      flagged,
    };
  }

  // ── GET /admin/referrals/config ──
  async getConfig() {
    const rows = await this.dataSource.query(
      `SELECT config_key, config_value, description, updated_at
         FROM referral_config ORDER BY config_key`,
    );
    return rows;
  }

  // ── PATCH /admin/referrals/config ──
  //   body: { wagering_multiplier: 8, ... } — only known keys; new referrals only.
  async updateConfig(updates: Record<string, any>, adminId: number) {
    const keys = Object.keys(updates ?? {}).filter((k) => EDITABLE_CONFIG.has(k));
    if (!keys.length)
      throw new BadRequestException(
        `No editable config keys. Allowed: ${[...EDITABLE_CONFIG].join(', ')}`,
      );

    for (const key of keys) {
      const value = String(updates[key]);
      if (!/^\d+(\.\d+)?$/.test(value))
        throw new BadRequestException(`${key} must be a non-negative number`);
      await this.dataSource.query(
        `UPDATE referral_config
            SET config_value = $1, updated_by = $2, updated_at = NOW()
          WHERE config_key = $3`,
        [value, adminId, key],
      );
    }
    return { message: 'Config updated (applies to NEW referrals only)', updated: keys };
  }
}

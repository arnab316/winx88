// src/affiliate/affiliate-weekly.service.ts
//
// Weekly (Friday-to-Friday) affiliate commission engine — the Figma
// "Promotion Settings" affiliate panel spec:
//
//   • A week runs Friday 00:00 → next Friday 00:00 (server time).
//   • Active player = downline user with ≥1 APPROVED real-cash deposit
//     decided inside the week. Bonus credits never count.
//   • Per-player contribution = deposits − withdrawals (APPROVED, by
//     decided_at). If a player withdrew as much as (or more than) they
//     deposited, they fall in the "no bonus" category and contribute 0 —
//     a player's negative week never eats other players' contributions.
//   • Commission = rate% × Σ per-player positive nets. Rate precedence:
//     per-affiliate override (affiliate_users.revshare_rate) → assigned
//     group rate → group whose min/max bracket matches the week's active
//     count → legacy affiliate_revshare_config ladder.
//   • The cron fires every Friday 00:30 ("Thursday after 12") and credits
//     the commission into affiliate_users.commission_balance, from which
//     the affiliate can request transfers to player accounts.
import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';

interface GroupRow {
  id: number;
  name: string;
  rev_share_pct: string;
  min_active_players: number;
  max_active_players: number | null;
}

interface WeekComputation {
  totalDeposits: number;
  totalWithdrawals: number;
  netAmount: number;            // Σ per-player max(deposits − withdrawals, 0)
  activePlayerCount: number;
  noBonusPlayerCount: number;
  players: Array<{
    userId: number;
    deposits: number;
    withdrawals: number;
    net: number;
    isActive: boolean;
    counted: boolean;
  }>;
}

@Injectable()
export class AffiliateWeeklyService {
  private readonly logger = new Logger(AffiliateWeeklyService.name);

  constructor(private dataSource: DataSource) {}

  // ── week helpers (server-local dates, week starts Friday) ─────
  private fridayOf(d: Date): Date {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() - 5 + 7) % 7));
    return x;
  }

  private addDays(d: Date, days: number): Date {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    return x;
  }

  private fmt(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  }

  /** Current running week: most recent Friday → next Friday. */
  currentWeekBounds(now = new Date()): { weekStart: string; weekEnd: string } {
    const start = this.fridayOf(now);
    return { weekStart: this.fmt(start), weekEnd: this.fmt(this.addDays(start, 7)) };
  }

  /** Last COMPLETED week (the one the Friday cron settles). */
  lastCompletedWeekBounds(now = new Date()): { weekStart: string; weekEnd: string } {
    const end = this.fridayOf(now);
    return { weekStart: this.fmt(this.addDays(end, -7)), weekEnd: this.fmt(end) };
  }

  private assertFriday(dateStr: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException('weekStart must be YYYY-MM-DD');
    }
    const [y, m, d] = dateStr.split('-').map(Number);
    if (new Date(y, m - 1, d).getDay() !== 5) {
      throw new BadRequestException('weekStart must be a Friday');
    }
  }

  // ── per-affiliate weekly computation (real cash only) ─────────
  private async computeWeek(
    ownerUserId: number,
    weekStart: string,
    weekEnd: string,
  ): Promise<WeekComputation> {
    const rows = await this.dataSource.query(
      `
      SELECT r.referee_user_id                    AS user_id,
             COALESCE(dep.total, 0)::numeric      AS deposits,
             COALESCE(wd.total, 0)::numeric       AS withdrawals
        FROM referrals r
        LEFT JOIN LATERAL (
          SELECT SUM(d.amount) AS total
            FROM deposits d
           WHERE d.user_id = r.referee_user_id
             AND d.status = 'APPROVED'
             AND d.decided_at >= $2::date AND d.decided_at < $3::date
        ) dep ON TRUE
        LEFT JOIN LATERAL (
          SELECT SUM(w.amount) AS total
            FROM withdrawals w
           WHERE w.user_id = r.referee_user_id
             AND w.status = 'APPROVED'
             AND w.decided_at >= $2::date AND w.decided_at < $3::date
        ) wd ON TRUE
       WHERE r.referrer_user_id = $1
      `,
      [ownerUserId, weekStart, weekEnd],
    );

    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let netAmount = 0;
    let activePlayerCount = 0;
    let noBonusPlayerCount = 0;

    const players = rows.map((r: any) => {
      const deposits = parseFloat(r.deposits);
      const withdrawals = parseFloat(r.withdrawals);
      const net = Math.round((deposits - withdrawals) * 100) / 100;
      const isActive = deposits > 0;
      const counted = isActive && net > 0;
      totalDeposits += deposits;
      totalWithdrawals += withdrawals;
      if (isActive) activePlayerCount++;
      if (isActive && !counted) noBonusPlayerCount++;
      if (counted) netAmount += net;
      return { userId: Number(r.user_id), deposits, withdrawals, net, isActive, counted };
    });

    return {
      totalDeposits: Math.round(totalDeposits * 100) / 100,
      totalWithdrawals: Math.round(totalWithdrawals * 100) / 100,
      netAmount: Math.round(netAmount * 100) / 100,
      activePlayerCount,
      noBonusPlayerCount,
      players,
    };
  }

  // ── rate resolution ────────────────────────────────────────────
  private async loadGroups(): Promise<GroupRow[]> {
    return this.dataSource.query(
      `SELECT id, name, rev_share_pct, min_active_players, max_active_players
         FROM affiliate_groups WHERE is_active = TRUE
        ORDER BY min_active_players ASC`,
    );
  }

  private resolveRate(
    af: { revshare_rate: string | null; group_id: number | null },
    activeCount: number,
    groups: GroupRow[],
    ladder: { tier1_max: number; tier2_max: number; tier3_max: number; rate1: number; rate2: number; rate3: number; rate4: number } | null,
  ): { rate: number; groupId: number | null } {
    if (af.revshare_rate != null) {
      return { rate: parseFloat(af.revshare_rate), groupId: af.group_id };
    }
    if (af.group_id != null) {
      const g = groups.find((x) => Number(x.id) === Number(af.group_id));
      if (g) return { rate: parseFloat(g.rev_share_pct), groupId: Number(g.id) };
    }
    const bracket = groups.find(
      (g) =>
        activeCount >= g.min_active_players &&
        (g.max_active_players == null || activeCount <= g.max_active_players),
    );
    if (bracket) return { rate: parseFloat(bracket.rev_share_pct), groupId: Number(bracket.id) };
    if (ladder) {
      if (activeCount <= ladder.tier1_max) return { rate: Number(ladder.rate1), groupId: null };
      if (activeCount <= ladder.tier2_max) return { rate: Number(ladder.rate2), groupId: null };
      if (activeCount <= ladder.tier3_max) return { rate: Number(ladder.rate3), groupId: null };
      return { rate: Number(ladder.rate4), groupId: null };
    }
    return { rate: 0, groupId: null };
  }

  // ═════════════════════════════════════════════════════════════
  // CRON / ADMIN: settle a week for every active affiliate
  // ═════════════════════════════════════════════════════════════
  async runWeekly(weekStartStr?: string) {
    let weekStart: string;
    let weekEnd: string;
    if (weekStartStr) {
      this.assertFriday(weekStartStr);
      weekStart = weekStartStr;
      const [y, m, d] = weekStartStr.split('-').map(Number);
      weekEnd = this.fmt(this.addDays(new Date(y, m - 1, d), 7));
    } else {
      ({ weekStart, weekEnd } = this.lastCompletedWeekBounds());
    }

    const groups = await this.loadGroups();
    const ladderRows = await this.dataSource.query(
      `SELECT tier1_max, tier2_max, tier3_max, rate1, rate2, rate3, rate4
         FROM affiliate_revshare_config WHERE id = 1`,
    );
    const ladder = ladderRows.length ? ladderRows[0] : null;

    const affiliates = await this.dataSource.query(
      `SELECT id, user_id, revshare_rate, group_id
         FROM affiliate_users WHERE is_active = TRUE AND status = 'ACTIVE'`,
    );

    const results: any[] = [];
    for (const af of affiliates) {
      try {
        const existing = await this.dataSource.query(
          `SELECT id, status FROM affiliate_weekly_commission
            WHERE affiliate_user_id = $1 AND week_start = $2`,
          [af.id, weekStart],
        );
        if (existing.length && existing[0].status === 'CREDITED') {
          results.push({ affiliateUserId: Number(af.id), skipped: 'already credited' });
          continue;
        }

        const calc = await this.computeWeek(Number(af.user_id), weekStart, weekEnd);
        const { rate } = this.resolveRate(af, calc.activePlayerCount, groups, ladder);
        const commission = Math.round(calc.netAmount * rate) / 100; // netAmount × rate%
        const status = commission > 0 ? 'CREDITED' : 'NO_BONUS';

        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
          const weeklyRows = await qr.query(
            `INSERT INTO affiliate_weekly_commission
               (affiliate_user_id, week_start, week_end, total_deposits, total_withdrawals,
                net_amount, active_player_count, no_bonus_player_count, revshare_rate,
                commission, status, computed_at, credited_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::varchar,NOW(),
                     CASE WHEN $11::text = 'CREDITED' THEN NOW() ELSE NULL END)
             ON CONFLICT (affiliate_user_id, week_start) DO UPDATE SET
               week_end = EXCLUDED.week_end,
               total_deposits = EXCLUDED.total_deposits,
               total_withdrawals = EXCLUDED.total_withdrawals,
               net_amount = EXCLUDED.net_amount,
               active_player_count = EXCLUDED.active_player_count,
               no_bonus_player_count = EXCLUDED.no_bonus_player_count,
               revshare_rate = EXCLUDED.revshare_rate,
               commission = EXCLUDED.commission,
               status = EXCLUDED.status,
               computed_at = NOW(),
               credited_at = CASE WHEN EXCLUDED.status = 'CREDITED' THEN NOW() ELSE NULL END
             RETURNING id`,
            [
              af.id, weekStart, weekEnd, calc.totalDeposits, calc.totalWithdrawals,
              calc.netAmount, calc.activePlayerCount, calc.noBonusPlayerCount, rate,
              commission, status,
            ],
          );
          const weeklyId = Number(weeklyRows[0].id);

          // Refresh the per-player audit rows for this week.
          await qr.query(
            `DELETE FROM affiliate_weekly_player_stats WHERE weekly_id = $1`,
            [weeklyId],
          );
          for (const p of calc.players) {
            // Idle players (no deposit AND no withdrawal) are skipped to keep
            // the audit table small; the report endpoint still lists them live.
            if (p.deposits === 0 && p.withdrawals === 0) continue;
            await qr.query(
              `INSERT INTO affiliate_weekly_player_stats
                 (weekly_id, user_id, deposits, withdrawals, net, is_active, counted)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [weeklyId, p.userId, p.deposits, p.withdrawals, p.net, p.isActive, p.counted],
            );
          }

          if (status === 'CREDITED') {
            const balRows = await qr.query(
              `SELECT commission_balance FROM affiliate_users WHERE id = $1 FOR UPDATE`,
              [af.id],
            );
            const before = parseFloat(balRows[0].commission_balance);
            const after = Math.round((before + commission) * 100) / 100;
            await qr.query(
              `UPDATE affiliate_users
                  SET commission_balance = $1,
                      lifetime_commission = lifetime_commission + $2,
                      updated_at = NOW()
                WHERE id = $3`,
              [after, commission, af.id],
            );
            await qr.query(
              `INSERT INTO affiliate_commission_ledger
                 (affiliate_user_id, entry_type, flow, amount, balance_before, balance_after,
                  reference_type, reference_id, description)
               VALUES ($1,'WEEKLY_COMMISSION','CREDIT',$2,$3,$4,'WEEKLY_COMMISSION',$5,$6)`,
              [
                af.id, commission, before, after, weeklyId,
                `Weekly commission ${weekStart} → ${weekEnd} (${rate}% of ${calc.netAmount})`,
              ],
            );
          }

          await qr.commitTransaction();
        } catch (e) {
          await qr.rollbackTransaction();
          throw e;
        } finally {
          await qr.release();
        }

        results.push({
          affiliateUserId: Number(af.id),
          activePlayers: calc.activePlayerCount,
          noBonusPlayers: calc.noBonusPlayerCount,
          netAmount: calc.netAmount,
          rate,
          commission,
          status,
        });
      } catch (e: any) {
        this.logger.error(`weekly run failed for affiliate ${af.id}: ${e.message}`);
        results.push({ affiliateUserId: Number(af.id), error: e.message });
      }
    }

    return { weekStart, weekEnd, processed: results.length, results };
  }

  // Friday 00:30 server time — settles the week that just ended.
  @Cron('30 0 * * 5')
  async weeklyCron(): Promise<void> {
    try {
      await this.runWeekly();
    } catch (e: any) {
      this.logger.error(`weekly cron failed: ${e.message}`);
    }
  }

  // ═════════════════════════════════════════════════════════════
  // AFFILIATE-FACING
  // ═════════════════════════════════════════════════════════════
  private async requireAffiliate(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT au.id, au.user_id, au.revshare_rate, au.group_id, au.status,
              au.commission_balance, au.lifetime_commission, au.is_active
         FROM affiliate_users au WHERE au.user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new ForbiddenException('You are not an affiliate');
    if (!rows[0].is_active || rows[0].status !== 'ACTIVE') {
      throw new ForbiddenException(`Your affiliate account is ${rows[0].status ?? 'inactive'}`);
    }
    return rows[0];
  }

  /**
   * GET /affiliate/me/overview — the partner-panel "Overview" dashboard,
   * with ALL-TIME totals (vs getWeeklyOverview's current-cycle figures):
   * balance, member list, active players, lifetime downline deposits +
   * wagered, earnings (available + pending review), lifetime earnings,
   * commission rate and the affiliate link/code.
   */
  async getMyOverview(userId: number) {
    const af = await this.requireAffiliate(userId);
    const { weekStart, weekEnd } = this.currentWeekBounds();

    const [calc, groups, ladderRows, totalsRows, pendingRows, userRows] = await Promise.all([
      // Reused only for the current-cycle active-player count ("now depositing").
      this.computeWeek(Number(af.user_id), weekStart, weekEnd),
      this.loadGroups(),
      this.dataSource.query(
        `SELECT tier1_max, tier2_max, tier3_max, rate1, rate2, rate3, rate4
           FROM affiliate_revshare_config WHERE id = 1`,
      ),
      // One pass over the downline for member count, all-time deposits and
      // all-time wagered (turnover) across every game source.
      this.dataSource.query(
        `WITH downline AS (
           SELECT referee_user_id AS uid FROM referrals WHERE referrer_user_id = $1
         )
         SELECT
           (SELECT COUNT(*) FROM downline)::int AS member_total,
           (SELECT COALESCE(SUM(w.total_deposited), 0)
              FROM wallets w WHERE w.user_id IN (SELECT uid FROM downline)) AS deposits_total,
           (SELECT COALESCE(SUM(b.bet_amount), 0)
              FROM bets b WHERE b.user_id IN (SELECT uid FROM downline)) AS wagered_lottery,
           (SELECT COALESCE(SUM(st.amount), 0)
              FROM slot_transactions st
             WHERE st.type = 'bet' AND st.user_id IN (SELECT uid FROM downline)) AS wagered_slot,
           (SELECT COALESCE(SUM(-ot.amount), 0)
              FROM oroplay_transactions ot
             WHERE ot.amount < 0 AND ot.is_canceled = FALSE
               AND ot.user_id IN (SELECT uid FROM downline)) AS wagered_oroplay,
           (SELECT COALESCE(SUM(sb.amount), 0)
              FROM sports_bet_logs sb WHERE sb.user_id IN (SELECT uid FROM downline)) AS wagered_sports`,
        [Number(af.user_id)],
      ),
      this.dataSource.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*)::int AS cnt
           FROM affiliate_transfers WHERE affiliate_user_id = $1 AND status = 'PENDING'`,
        [af.id],
      ),
      this.dataSource.query(
        `SELECT referral_code, user_code FROM users WHERE id = $1`,
        [Number(af.user_id)],
      ),
    ]);

    const ladder = ladderRows.length ? ladderRows[0] : null;
    const { rate } = this.resolveRate(af, calc.activePlayerCount, groups, ladder);

    const t = totalsRows[0];
    const wagered =
      parseFloat(t.wagered_lottery) +
      parseFloat(t.wagered_slot) +
      parseFloat(t.wagered_oroplay) +
      parseFloat(t.wagered_sports);

    const code = userRows.length
      ? (userRows[0].referral_code ?? userRows[0].user_code)
      : null;
    const base = process.env.PUBLIC_SITE_URL ?? process.env.APP_BASE_URL ?? 'https://winx-88.com';

    const balance = parseFloat(af.commission_balance);
    const lifetime = parseFloat(af.lifetime_commission);

    return {
      balance,
      members: {
        total: t.member_total,
        activePlayers: calc.activePlayerCount, // deposited in the current cycle
      },
      deposits: {
        total: Math.round(parseFloat(t.deposits_total) * 100) / 100,
        wagered: Math.round(wagered * 100) / 100,
      },
      earnings: {
        available: balance,
        pendingReview: parseFloat(pendingRows[0].total),
        pendingReviewCount: pendingRows[0].cnt,
      },
      lifetimeEarnings: lifetime,
      affiliate: {
        code,
        commissionRate: rate,
        lifetimePaid: lifetime,
        trackingLink: code ? `${base}/r/${code}` : null,
      },
    };
  }

  /**
   * GET /affiliate/me/weekly/overview — the user-panel Overview KPIs:
   * member list, active players, week deposits/withdrawals, projected
   * commission, commission balance ("Earnings") and lifetime earnings.
   */
  async getWeeklyOverview(userId: number) {
    const af = await this.requireAffiliate(userId);
    const { weekStart, weekEnd } = this.currentWeekBounds();

    const [calc, groups, ladderRows, memberRows, pendingRows, lastWeekRows] = await Promise.all([
      this.computeWeek(Number(af.user_id), weekStart, weekEnd),
      this.loadGroups(),
      this.dataSource.query(
        `SELECT tier1_max, tier2_max, tier3_max, rate1, rate2, rate3, rate4
           FROM affiliate_revshare_config WHERE id = 1`,
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM referrals WHERE referrer_user_id = $1`,
        [userId],
      ),
      this.dataSource.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*)::int AS cnt
           FROM affiliate_transfers WHERE affiliate_user_id = $1 AND status = 'PENDING'`,
        [af.id],
      ),
      this.dataSource.query(
        `SELECT week_start, week_end, commission, status, credited_at
           FROM affiliate_weekly_commission
          WHERE affiliate_user_id = $1 ORDER BY week_start DESC LIMIT 1`,
        [af.id],
      ),
    ]);

    const ladder = ladderRows.length ? ladderRows[0] : null;
    const { rate, groupId } = this.resolveRate(af, calc.activePlayerCount, groups, ladder);
    const group = groupId != null ? groups.find((g) => Number(g.id) === groupId) : null;

    return {
      week: { start: weekStart, end: weekEnd, payoutAt: weekEnd },
      members: {
        total: memberRows[0].total,
        activeThisWeek: calc.activePlayerCount,
        noBonusThisWeek: calc.noBonusPlayerCount,
      },
      currentWeek: {
        totalDeposits: calc.totalDeposits,
        totalWithdrawals: calc.totalWithdrawals,
        netAmount: calc.netAmount,
        revshareRate: rate,
        projectedCommission: Math.round(calc.netAmount * rate) / 100,
      },
      earnings: {
        commissionBalance: parseFloat(af.commission_balance),
        lifetimeCommission: parseFloat(af.lifetime_commission),
        pendingTransfers: parseFloat(pendingRows[0].total),
        pendingTransferCount: pendingRows[0].cnt,
      },
      group: group
        ? { id: Number(group.id), name: group.name, revSharePct: parseFloat(group.rev_share_pct) }
        : null,
      lastSettledWeek: lastWeekRows.length ? lastWeekRows[0] : null,
    };
  }

  /** GET /affiliate/me/weekly/history — settled weekly commission rows. */
  async getMyWeeklyHistory(userId: number, page = 1, limit = 20) {
    const af = await this.requireAffiliate(userId);
    return this.weeklyHistoryFor(Number(af.id), page, limit);
  }

  /** ADMIN: weekly history by the affiliate's users.id. */
  async getWeeklyHistoryForUser(userId: number, page = 1, limit = 20) {
    const rows = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('Affiliate not found');
    return this.weeklyHistoryFor(Number(rows[0].id), page, limit);
  }

  private async weeklyHistoryFor(affiliateUserId: number, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT id, week_start, week_end, total_deposits, total_withdrawals, net_amount,
                active_player_count, no_bonus_player_count, revshare_rate, commission,
                status, computed_at, credited_at
           FROM affiliate_weekly_commission
          WHERE affiliate_user_id = $1
          ORDER BY week_start DESC
          LIMIT $2 OFFSET $3`,
        [affiliateUserId, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM affiliate_weekly_commission WHERE affiliate_user_id = $1`,
        [affiliateUserId],
      ),
    ]);
    return { data: rows, total: count[0].total, page, limit };
  }

  // ═════════════════════════════════════════════════════════════
  // PLAYER REPORT — deposits / withdrawals / P&L per downline user
  //   (affiliate-facing and admin-facing share this query)
  // ═════════════════════════════════════════════════════════════
  async getPlayerReport(
    ownerUserId: number,
    opts: { from?: string; to?: string; q?: string; page?: number; limit?: number } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const offset = (page - 1) * limit;

    // Default window = the current running week.
    const { weekStart, weekEnd } = this.currentWeekBounds();
    const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : weekStart;
    // `to` is inclusive → compare < to+1day.
    const to = opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : weekEnd;

    const params: any[] = [ownerUserId, from, to];
    let qFilter = '';
    if (opts.q?.trim()) {
      params.push(`%${opts.q.trim()}%`);
      qFilter = `AND (u.username ILIKE $4 OR u.user_code ILIKE $4 OR u.full_name ILIKE $4)`;
    }

    const rows = await this.dataSource.query(
      `
      SELECT u.id, u.user_code, u.username, u.full_name, u.account_status,
             u.created_at AS joined_at, r.created_at AS referred_at,
             COALESCE(dep.total, 0)::numeric AS deposits,
             COALESCE(wd.total, 0)::numeric  AS withdrawals
        FROM referrals r
        JOIN users u ON u.id = r.referee_user_id
        LEFT JOIN LATERAL (
          SELECT SUM(d.amount) AS total FROM deposits d
           WHERE d.user_id = u.id AND d.status = 'APPROVED'
             AND d.decided_at >= $2::date AND d.decided_at < ($3::date + INTERVAL '1 day')
        ) dep ON TRUE
        LEFT JOIN LATERAL (
          SELECT SUM(w.amount) AS total FROM withdrawals w
           WHERE w.user_id = u.id AND w.status = 'APPROVED'
             AND w.decided_at >= $2::date AND w.decided_at < ($3::date + INTERVAL '1 day')
        ) wd ON TRUE
       WHERE r.referrer_user_id = $1
       ${qFilter}
       ORDER BY COALESCE(dep.total, 0) DESC, r.created_at DESC
      `,
      params,
    );

    const mapped = rows.map((r: any) => {
      const deposits = parseFloat(r.deposits);
      const withdrawals = parseFloat(r.withdrawals);
      const net = Math.round((deposits - withdrawals) * 100) / 100;
      const isActive = deposits > 0;
      return {
        userId: Number(r.id),
        userCode: r.user_code,
        username: r.username,
        fullName: r.full_name,
        accountStatus: r.account_status,
        joinedAt: r.joined_at,
        referredAt: r.referred_at,
        deposits,
        withdrawals,
        // player P&L from the affiliate's ledger: positive = net cash-in
        profitLoss: net,
        category: !isActive ? 'INACTIVE' : net > 0 ? 'ACTIVE' : 'NO_BONUS',
      };
    });

    const summary = {
      totalPlayers: mapped.length,
      activePlayers: mapped.filter((m) => m.category === 'ACTIVE').length,
      noBonusPlayers: mapped.filter((m) => m.category === 'NO_BONUS').length,
      totalDeposits: Math.round(mapped.reduce((s, m) => s + m.deposits, 0) * 100) / 100,
      totalWithdrawals: Math.round(mapped.reduce((s, m) => s + m.withdrawals, 0) * 100) / 100,
    };

    return {
      from,
      to,
      summary,
      data: mapped.slice(offset, offset + limit),
      total: mapped.length,
      page,
      limit,
    };
  }

  /** Affiliate-facing wrapper: enforces the caller is an active affiliate. */
  async getMyPlayerReport(
    userId: number,
    opts: { from?: string; to?: string; q?: string; page?: number; limit?: number } = {},
  ) {
    await this.requireAffiliate(userId);
    return this.getPlayerReport(userId, opts);
  }

  /** ADMIN wrapper by the affiliate's users.id. */
  async getPlayerReportForUser(
    userId: number,
    opts: { from?: string; to?: string; q?: string; page?: number; limit?: number } = {},
  ) {
    const rows = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('Affiliate not found');
    return this.getPlayerReport(userId, opts);
  }

  /** Commission-balance ledger (affiliate-facing statement). */
  async getMyCommissionLedger(userId: number, page = 1, limit = 20) {
    const af = await this.requireAffiliate(userId);
    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT id, entry_type, flow, amount, balance_before, balance_after,
                reference_type, reference_id, description, created_at
           FROM affiliate_commission_ledger
          WHERE affiliate_user_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [af.id, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM affiliate_commission_ledger WHERE affiliate_user_id = $1`,
        [af.id],
      ),
    ]);
    return { data: rows, total: count[0].total, page, limit };
  }
}

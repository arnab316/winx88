// src/affiliate/affiliate-revshare.service.ts
//
// RevShare program engine (build-guide §7). Layered on top of the existing
// referral-commission AffiliateService — it does not touch that flow.
//
// Monthly cycle:
//   1st 00:00  → compute prior-month NGR per affiliate, apply NNCO, check the
//                active-player minimum + payout threshold, roll forward
//                sub-threshold balances, and queue payable rows.
//   Finance then marks rows paid by the 5th.
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';

export interface RevShareConfig {
  admin_fee_pct: number;
  min_threshold: number;
  min_active_players: number;
  tier1_max: number;
  tier2_max: number;
  tier3_max: number;
  rate1: number;
  rate2: number;
  rate3: number;
  rate4: number;
}

@Injectable()
export class AffiliateRevShareService {
  constructor(private dataSource: DataSource) {}

  // ── period helpers (UTC; convert at the edge per §10 timezone note) ──
  private periodBounds(period: string): { start: string; end: string } {
    const [y, m] = period.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1)); // first day of next month
    return { start: start.toISOString(), end: end.toISOString() };
  }

  private prevMonthPeriod(now = new Date()): string {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private tierForCount(count: number, cfg: RevShareConfig): { tier: number; rate: number } {
    if (count <= cfg.tier1_max) return { tier: 1, rate: Number(cfg.rate1) };
    if (count <= cfg.tier2_max) return { tier: 2, rate: Number(cfg.rate2) };
    if (count <= cfg.tier3_max) return { tier: 3, rate: Number(cfg.rate3) };
    return { tier: 4, rate: Number(cfg.rate4) };
  }

  // ═════════════════════════════════════════════════════════════
  // CONFIG
  // ═════════════════════════════════════════════════════════════
  async getConfig(): Promise<RevShareConfig> {
    const rows = await this.dataSource.query(
      `SELECT * FROM affiliate_revshare_config WHERE id = 1`,
    );
    if (!rows.length) throw new NotFoundException('RevShare config not initialised');
    return rows[0];
  }

  async updateConfig(patch: Record<string, number>, adminId: number) {
    const allowed = [
      'admin_fee_pct', 'min_threshold', 'min_active_players',
      'tier1_max', 'tier2_max', 'tier3_max', 'rate1', 'rate2', 'rate3', 'rate4',
    ];
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        values.push(patch[key]);
      }
    }
    if (!fields.length) throw new BadRequestException('No config fields to update');
    fields.push(`updated_by_admin_id = $${i++}`, `updated_at = NOW()`);
    values.push(adminId);
    const rows = await this.dataSource.query(
      `UPDATE affiliate_revshare_config SET ${fields.join(', ')} WHERE id = 1 RETURNING *`,
      values,
    );
    return rows[0];
  }

  // ═════════════════════════════════════════════════════════════
  // NGR computation for one affiliate over a period
  //   Downline = users referred by the affiliate (referrals table).
  //   Betting is summed from the native `bets` table + slot_transactions.
  // ═════════════════════════════════════════════════════════════
  private async computeAffiliatePeriod(
    affiliateUserId: number,
    affiliateOwnerUserId: number,
    period: string,
    cfg: RevShareConfig,
    customRate: number | null,
    // The affiliate's assigned-group rate (null if not in a group). Used as the
    // fallback BEFORE the legacy config tier-ladder, so group membership drives
    // the revshare — consistent with the weekly engine's resolveRate().
    groupRate: number | null = null,
  ) {
    const { start, end } = this.periodBounds(period);

    // Betting totals across native bets + slot provider
    const betRows = await this.dataSource.query(
      `
      SELECT
        COALESCE(SUM(bet_amount), 0)  AS total_bets,
        COALESCE(SUM(win_amount), 0)  AS total_wins
      FROM (
        SELECT b.bet_amount AS bet_amount,
               CASE WHEN b.result_status = 'WON' THEN b.potential_payout ELSE 0 END AS win_amount
          FROM bets b
          JOIN referrals r ON r.referee_user_id = b.user_id
         WHERE r.referrer_user_id = $1
           AND b.placed_at >= $2::timestamptz AND b.placed_at < $3::timestamptz
        UNION ALL
        SELECT CASE WHEN s.type = 'bet' THEN s.amount ELSE 0 END,
               CASE WHEN s.type = 'win' THEN s.amount ELSE 0 END
          FROM slot_transactions s
          JOIN referrals r ON r.referee_user_id = s.user_id
         WHERE r.referrer_user_id = $1
           AND s.is_cancelled = FALSE
           AND s.created_at >= $2::timestamp AND s.created_at < $3::timestamp
      ) t
      `,
      [affiliateOwnerUserId, start, end],
    );
    const totalBets = parseFloat(betRows[0].total_bets);
    const totalWins = parseFloat(betRows[0].total_wins);

    // Bonuses given to downline in the period
    const bonusRows = await this.dataSource.query(
      `SELECT COALESCE(SUM(c.bonus_amount), 0) AS total
         FROM user_promotion_claims c
         JOIN referrals r ON r.referee_user_id = c.user_id
        WHERE r.referrer_user_id = $1
          AND c.status IN ('ACTIVE','COMPLETED')
          AND c.claimed_at >= $2::timestamptz AND c.claimed_at < $3::timestamptz`,
      [affiliateOwnerUserId, start, end],
    );
    const bonusesGiven = parseFloat(bonusRows[0].total);

    // Active players: deposited (approved) AND bet in the period
    const activeRows = await this.dataSource.query(
      `
      SELECT COUNT(*)::int AS cnt FROM (
        SELECT r.referee_user_id AS uid
          FROM referrals r
         WHERE r.referrer_user_id = $1
           AND EXISTS (
             SELECT 1 FROM deposits d
              WHERE d.user_id = r.referee_user_id AND d.status = 'APPROVED'
                AND d.decided_at >= $2::timestamptz AND d.decided_at < $3::timestamptz)
           AND (
             EXISTS (SELECT 1 FROM bets b
                      WHERE b.user_id = r.referee_user_id
                        AND b.placed_at >= $2::timestamptz AND b.placed_at < $3::timestamptz)
             OR EXISTS (SELECT 1 FROM slot_transactions s
                      WHERE s.user_id = r.referee_user_id AND s.type = 'bet'
                        AND s.created_at >= $2::timestamp AND s.created_at < $3::timestamp)
           )
      ) act
      `,
      [affiliateOwnerUserId, start, end],
    );
    const activePlayerCount = Number(activeRows[0].cnt);

    // Commission basis = real-cash NET DEPOSIT, matching the weekly payout
    // engine exactly: per referred player, (approved deposits − approved
    // withdrawals) in the period, with a PER-PLAYER positive clamp — a player
    // whose withdrawals exceed deposits contributes 0, never a negative that
    // drags down other players. commission = Σ max(dep − wd, 0) × rate.
    // (NGR below is kept for informational display only; it is NOT the basis.)
    const netRows = await this.dataSource.query(
      `SELECT COALESCE(SUM(GREATEST(net, 0)), 0) AS net_deposits
         FROM (
           SELECT COALESCE(dep.total, 0) - COALESCE(wd.total, 0) AS net
             FROM referrals r
             LEFT JOIN LATERAL (
               SELECT SUM(d.amount) AS total FROM deposits d
                WHERE d.user_id = r.referee_user_id AND d.status = 'APPROVED'
                  AND d.decided_at >= $2::date AND d.decided_at < $3::date
             ) dep ON TRUE
             LEFT JOIN LATERAL (
               SELECT SUM(w.amount) AS total FROM withdrawals w
                WHERE w.user_id = r.referee_user_id AND w.status = 'APPROVED'
                  AND w.decided_at >= $2::date AND w.decided_at < $3::date
             ) wd ON TRUE
            WHERE r.referrer_user_id = $1
         ) t`,
      [affiliateOwnerUserId, start, end],
    );
    const netDeposits = parseFloat(netRows[0].net_deposits);

    // NGR figures — informational only (bets/wins/bonuses/fee), no longer the
    // commission basis.
    const grossWin = Math.max(totalBets - totalWins, 0);
    const adminFee = (grossWin * Number(cfg.admin_fee_pct)) / 100;
    const ngr = totalBets - totalWins - bonusesGiven - adminFee;

    const { tier, rate: tierRate } = this.tierForCount(activePlayerCount, cfg);
    // Precedence: per-affiliate override → assigned group rate → legacy ladder.
    const rate = customRate ?? groupRate ?? tierRate;

    // Commission = net deposits × revshare% (floored at 0).
    const grossEarning = netDeposits > 0 ? (netDeposits * rate) / 100 : 0;

    return {
      totalBets, totalWins, bonusesGiven, adminFee, ngr,
      netDeposits: Math.round(netDeposits * 100) / 100,
      activePlayerCount, tier, rate,
      grossEarning: Math.round(grossEarning * 100) / 100,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN/CRON: run the monthly computation for a period (YYYY-MM)
  // ═════════════════════════════════════════════════════════════
  async runMonthly(period: string) {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new BadRequestException('period must be YYYY-MM');
    }
    const cfg = await this.getConfig();

    const affiliates = await this.dataSource.query(
      `SELECT au.id, au.user_id, au.revshare_rate, au.group_id,
              g.rev_share_pct AS group_rate
         FROM affiliate_users au
         LEFT JOIN affiliate_groups g ON g.id = au.group_id
        WHERE au.is_active = TRUE`,
    );

    const results: any[] = [];
    for (const af of affiliates) {
      // Skip rows already paid for this period
      const existing = await this.dataSource.query(
        `SELECT status FROM affiliate_monthly_ngr
          WHERE affiliate_user_id = $1 AND period = $2`,
        [af.id, period],
      );
      if (existing.length && existing[0].status === 'PAID') {
        results.push({ affiliateUserId: af.id, skipped: 'already paid' });
        continue;
      }

      const customRate = af.revshare_rate != null ? parseFloat(af.revshare_rate) : null;
      const groupRate = af.group_rate != null ? parseFloat(af.group_rate) : null;
      const calc = await this.computeAffiliatePeriod(
        af.id, Number(af.user_id), period, cfg, customRate, groupRate,
      );

      // Carry-in = prior month's carried_forward (rolled-forward balance)
      const prevPeriod = this.prevMonthPeriod(this.periodStartDate(period));
      const prevRows = await this.dataSource.query(
        `SELECT carried_forward FROM affiliate_monthly_ngr
          WHERE affiliate_user_id = $1 AND period = $2`,
        [af.id, prevPeriod],
      );
      const carriedIn = prevRows.length ? parseFloat(prevRows[0].carried_forward) : 0;

      const total = calc.grossEarning + carriedIn;

      let status: string;
      let payable = 0;
      let carriedForward = 0;
      if (calc.activePlayerCount < cfg.min_active_players) {
        // Below active-player minimum: no payout, roll the balance forward
        status = 'SKIPPED';
        carriedForward = total;
      } else if (total < Number(cfg.min_threshold)) {
        status = 'ROLLED_FORWARD';
        carriedForward = total;
      } else {
        status = 'PAYABLE';
        payable = total;
      }

      await this.dataSource.query(
        `INSERT INTO affiliate_monthly_ngr
          (affiliate_user_id, period, total_bets, total_wins, bonuses_given,
           admin_fee, ngr, active_player_count, revshare_rate, gross_earning,
           carried_in, carried_forward, payable_amount, status, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (affiliate_user_id, period) DO UPDATE SET
           total_bets = EXCLUDED.total_bets,
           total_wins = EXCLUDED.total_wins,
           bonuses_given = EXCLUDED.bonuses_given,
           admin_fee = EXCLUDED.admin_fee,
           ngr = EXCLUDED.ngr,
           active_player_count = EXCLUDED.active_player_count,
           revshare_rate = EXCLUDED.revshare_rate,
           gross_earning = EXCLUDED.gross_earning,
           carried_in = EXCLUDED.carried_in,
           carried_forward = EXCLUDED.carried_forward,
           payable_amount = EXCLUDED.payable_amount,
           status = EXCLUDED.status,
           computed_at = NOW()`,
        [
          af.id, period, calc.totalBets, calc.totalWins, calc.bonusesGiven,
          calc.adminFee, calc.ngr, calc.activePlayerCount, calc.rate, calc.grossEarning,
          carriedIn, carriedForward, payable, status,
        ],
      );

      // Keep the affiliate's current tier/rate snapshot fresh
      await this.dataSource.query(
        `UPDATE affiliate_users SET revshare_tier = $1, updated_at = NOW() WHERE id = $2`,
        [calc.tier, af.id],
      );

      results.push({
        affiliateUserId: af.id,
        ngr: calc.ngr,
        activePlayers: calc.activePlayerCount,
        rate: calc.rate,
        payable,
        carriedForward,
        status,
      });
    }

    return { period, processed: results.length, results };
  }

  private periodStartDate(period: string): Date {
    const [y, m] = period.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1));
  }

  // ═════════════════════════════════════════════════════════════
  // CRON: monthly run on the 1st at 00:00 (server time)
  // ═════════════════════════════════════════════════════════════
  @Cron('0 0 1 * *')
  async monthlyCron(): Promise<void> {
    const period = this.prevMonthPeriod();
    await this.runMonthly(period);
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: pending payouts for a month
  // ═════════════════════════════════════════════════════════════
  async getPendingPayouts(month?: string) {
    const params: any[] = [];
    let where = `WHERE m.status = 'PAYABLE'`;
    if (month) {
      params.push(month);
      where += ` AND m.period = $1`;
    }
    return this.dataSource.query(
      `SELECT m.*, u.user_code, u.username, u.full_name,
              au.payment_method, au.payment_details
         FROM affiliate_monthly_ngr m
         JOIN affiliate_users au ON au.id = m.affiliate_user_id
         JOIN users u ON u.id = au.user_id
         ${where}
         ORDER BY m.payable_amount DESC`,
      params,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: mark a payout as disbursed
  // ═════════════════════════════════════════════════════════════
  async markPaid(ngrId: number, txnRef: string, paidAt?: string) {
    const rows = await this.dataSource.query(
      `SELECT status FROM affiliate_monthly_ngr WHERE id = $1`,
      [ngrId],
    );
    if (!rows.length) throw new NotFoundException('Payout row not found');
    if (rows[0].status !== 'PAYABLE') {
      throw new BadRequestException(`Only PAYABLE rows can be marked paid (current: ${rows[0].status})`);
    }
    const result = await this.dataSource.query(
      `UPDATE affiliate_monthly_ngr
          SET status = 'PAID', txn_ref = $1, paid_at = COALESCE($2::timestamptz, NOW())
        WHERE id = $3 RETURNING *`,
      [txnRef, paidAt ?? null, ngrId],
    );
    return result[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: set an affiliate's RevShare tier override / payment method
  // ═════════════════════════════════════════════════════════════
  async setRevshare(
    affiliateUserId: number,
    dto: { customRate?: number; paymentMethod?: string; paymentDetails?: any },
  ) {
    const rows = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE id = $1`,
      [affiliateUserId],
    );
    if (!rows.length) throw new NotFoundException('Affiliate not found');

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (dto.customRate !== undefined) { fields.push(`revshare_rate = $${i++}`); values.push(dto.customRate); }
    if (dto.paymentMethod !== undefined) { fields.push(`payment_method = $${i++}`); values.push(dto.paymentMethod); }
    if (dto.paymentDetails !== undefined) { fields.push(`payment_details = $${i++}`); values.push(JSON.stringify(dto.paymentDetails)); }
    if (!fields.length) throw new BadRequestException('Nothing to update');
    fields.push(`updated_at = NOW()`);
    values.push(affiliateUserId);
    const result = await this.dataSource.query(
      `UPDATE affiliate_users SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return result[0];
  }

  async getNgrHistory(affiliateUserId: number) {
    return this.dataSource.query(
      `SELECT * FROM affiliate_monthly_ngr
        WHERE affiliate_user_id = $1 ORDER BY period DESC`,
      [affiliateUserId],
    );
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: consolidated detail for one affiliate (by users.id)
  //   winX88partners affiliate-detail page — header + KPIs + payouts.
  // ═════════════════════════════════════════════════════════════
  async getAffiliateDetail(userId: number) {
    const afRows = await this.dataSource.query(
      `SELECT au.id, au.user_id, au.is_active, au.commission_pct,
              au.revshare_tier, au.revshare_rate, au.payment_method, au.payment_details,
              au.approved_at,
              au.status AS aff_status, au.remark, au.group_id,
              au.commission_balance, au.lifetime_commission,
              g.name AS group_name, g.rev_share_pct AS group_rate,
              p.phone_number,
              u.username, u.full_name, u.email, u.user_code, u.referral_code, u.account_status
         FROM affiliate_users au
         JOIN users u ON u.id = au.user_id
         LEFT JOIN affiliate_groups g ON g.id = au.group_id
         LEFT JOIN LATERAL (
           SELECT phone_number FROM user_phone_numbers
            WHERE user_id = u.id ORDER BY is_primary DESC, id ASC LIMIT 1
         ) p ON TRUE
        WHERE au.user_id = $1
        LIMIT 1`,
      [userId],
    );
    if (!afRows.length) throw new NotFoundException('Affiliate not found');
    const af = afRows[0];

    const cfg = await this.getConfig();
    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const customRate = af.revshare_rate != null ? parseFloat(af.revshare_rate) : null;
    const groupRate = af.group_id != null && af.group_rate != null ? parseFloat(af.group_rate) : null;
    // Live month-to-date figures (active players / NGR / projected payout).
    const live = await this.computeAffiliatePeriod(
      af.id, Number(af.user_id), period, cfg, customRate, groupRate,
    );

    const [paidRows, refRows, depRows, clickRows] = await Promise.all([
      this.dataSource.query(
        `SELECT COALESCE(SUM(payable_amount),0) AS v
           FROM affiliate_monthly_ngr WHERE affiliate_user_id = $1 AND status = 'PAID'`,
        [af.id],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS v FROM referrals WHERE referrer_user_id = $1`,
        [af.user_id],
      ),
      this.dataSource.query(
        `SELECT COALESCE(SUM(w.total_deposited),0) AS v
           FROM referrals r JOIN wallets w ON w.user_id = r.referee_user_id
          WHERE r.referrer_user_id = $1`,
        [af.user_id],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS v FROM affiliate_clicks WHERE referrer_user_id = $1`,
        [af.user_id],
      ),
    ]);

    // Payouts feed = WEEKLY COMMISSION credits + admin ADJUSTMENTS (credit/
    // debit), newest-first — the affiliate's real commission history. (Monthly
    // NGR is not used.) Each entry has `type`: 'COMMISSION' | 'ADJUSTMENT' and
    // `flow`: 'CREDIT' | 'DEBIT'; adjustment rows carry the remark + which admin.
    const ledgerRows = await this.dataSource.query(
      `SELECT acl.id, acl.entry_type, acl.flow, acl.amount, acl.balance_after,
              acl.description AS remark, acl.reference_type, acl.reference_id,
              acl.created_at,
              a.name AS admin_name, a.email AS admin_email
         FROM affiliate_commission_ledger acl
         LEFT JOIN admin_users a
           ON acl.reference_type = 'ADMIN' AND a.id = acl.reference_id
        WHERE acl.affiliate_user_id = $1
          AND acl.entry_type IN ('WEEKLY_COMMISSION', 'ADMIN_ADJUST')
        ORDER BY acl.created_at DESC, acl.id DESC`,
      [af.id],
    );
    const payouts = ledgerRows.map((r: any) => ({
      type: r.entry_type === 'WEEKLY_COMMISSION' ? 'COMMISSION' : 'ADJUSTMENT',
      id: Number(r.id),
      flow: r.flow, // CREDIT | DEBIT
      amount: parseFloat(r.amount),
      balanceAfter: parseFloat(r.balance_after),
      remark: r.remark,
      // Only ADJUSTMENT rows have an acting admin.
      adminName: r.admin_name ?? null,
      adminEmail: r.admin_email ?? null,
      createdAt: r.created_at,
    }));

    return {
      affiliate: {
        affiliateUserId: af.id,
        userId: af.user_id,
        username: af.username,
        fullName: af.full_name,
        email: af.email,
        userCode: af.user_code,
        referralCode: af.referral_code,
        accountStatus: af.account_status,
        phone: af.phone_number ?? null,
        isActive: af.is_active,
        status: (af.aff_status ?? (af.is_active ? 'ACTIVE' : 'INACTIVE')).toLowerCase(),
        remark: af.remark ?? null,
        group: af.group_id != null
          ? { id: Number(af.group_id), name: af.group_name, revSharePct: parseFloat(af.group_rate) }
          : null,
        commissionBalance: parseFloat(af.commission_balance ?? '0'),
        lifetimeCommission: parseFloat(af.lifetime_commission ?? '0'),
        tier: af.revshare_tier ?? live.tier,
        revshareRate: customRate ?? live.rate,
        commissionPct: af.commission_pct != null ? parseFloat(af.commission_pct) : 0,
        paymentMethod: af.payment_method,
        paymentDetails: af.payment_details,
        approvedAt: af.approved_at,
      },
      kpis: {
        lifetimePaid: parseFloat(paidRows[0].v),
        // MTD commission = Σ per-player max(deposits − withdrawals, 0) × rate.
        pendingCommission: live.grossEarning,
        playerDeposits: parseFloat(depRows[0].v),
        referredPlayers: Number(refRows[0].v),
        activePlayers: live.activePlayerCount,
        totalClicks: Number(clickRows[0].v),
      },
      currentMonth: {
        period,
        // The commission basis (real-cash net deposit) and the resulting payout.
        netDeposits: live.netDeposits,
        ngr: live.ngr,
        totalBets: live.totalBets,
        totalWins: live.totalWins,
        bonusesGiven: live.bonusesGiven,
        adminFee: live.adminFee,
        projectedPayout: live.grossEarning,
      },
      payouts,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // AFFILIATE-FACING
  // ═════════════════════════════════════════════════════════════
  private async requireActiveAffiliate(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT au.id, au.user_id, au.revshare_tier, au.revshare_rate, au.group_id,
              g.rev_share_pct AS group_rate
         FROM affiliate_users au
         LEFT JOIN affiliate_groups g ON g.id = au.group_id
        WHERE au.user_id = $1 AND au.is_active = TRUE LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('You are not an active affiliate');
    return rows[0];
  }

  // GET /affiliate/me/overview — tier, active players, MTD NGR, projected payout
  async getOverview(userId: number) {
    const af = await this.requireActiveAffiliate(userId);
    const cfg = await this.getConfig();

    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const customRate = af.revshare_rate != null ? parseFloat(af.revshare_rate) : null;
    const groupRate = af.group_id != null && af.group_rate != null ? parseFloat(af.group_rate) : null;
    const calc = await this.computeAffiliatePeriod(af.id, Number(af.user_id), period, cfg, customRate, groupRate);

    return {
      period,
      tier: calc.tier,
      revshareRate: calc.rate,
      activePlayerCount: calc.activePlayerCount,
      mtd: {
        totalBets: calc.totalBets,
        totalWins: calc.totalWins,
        bonusesGiven: calc.bonusesGiven,
        adminFee: calc.adminFee,
        ngr: calc.ngr,
      },
      projectedPayout: calc.grossEarning,
      thresholds: {
        minActivePlayers: cfg.min_active_players,
        minThreshold: Number(cfg.min_threshold),
      },
    };
  }

  // GET /affiliate/me/payouts — historical monthly payouts
  async getMyPayouts(userId: number) {
    const af = await this.requireActiveAffiliate(userId);
    return this.dataSource.query(
      `SELECT period, ngr, active_player_count, revshare_rate, gross_earning,
              carried_in, carried_forward, payable_amount, status, txn_ref, paid_at
         FROM affiliate_monthly_ngr
        WHERE affiliate_user_id = $1 ORDER BY period DESC`,
      [af.id],
    );
  }

  // GET /affiliate/me/link — tracking link / referral code
  async getMyLink(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT user_code FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('User not found');
    // AFFILIATE attribution is keyed by user_code (attachAffiliateOnSignup
    // matches u.user_code) — NOT referral_code, which belongs to the separate
    // refer-a-friend system (?ref=). The link lands directly on the register
    // page carrying ?affiliateCode=, which the signup form forwards in the
    // register body.
    const code = rows[0].user_code;
    const base = process.env.PUBLIC_SITE_URL ?? process.env.APP_BASE_URL ?? 'https://winx-88.com';
    return {
      affiliateCode: code,
      trackingLink: `${base}/register?affiliateCode=${encodeURIComponent(code)}`,
    };
  }
}

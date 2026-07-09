import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ApplyAffiliateDto,
  DecideApplicationDto,
  UpdateCommissionDto,
  ToggleAffiliateDto,
} from './dto';

@Injectable()
export class AffiliateService {
  constructor(private dataSource: DataSource) {}

  // ─────────────────────────────────────────────────────────────
  // USER: apply to become affiliate
  // ─────────────────────────────────────────────────────────────

  async applyAffiliate(dto: ApplyAffiliateDto) {
    // Check user exists and is ACTIVE
    const user = await this.dataSource.query(
      `SELECT id, account_status, user_code FROM users WHERE id = $1 LIMIT 1`,
      [dto.userId],
    );
    if (!user.length) throw new NotFoundException('User not found');
    if (user[0].account_status !== 'ACTIVE')
      throw new ForbiddenException(`Account is ${user[0].account_status}`);

    // Check not already an affiliate
    const existing = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
      [dto.userId],
    );
    if (existing.length)
      throw new ConflictException('User is already an affiliate');

    // Check no pending/approved application
    const existingApp = await this.dataSource.query(
      `SELECT id, status FROM affiliate_applications WHERE user_id = $1 LIMIT 1`,
      [dto.userId],
    );
    if (existingApp.length) {
      const status = existingApp[0].status;
      if (status === 'PENDING')
        throw new ConflictException('Application already submitted and pending');
      if (status === 'APPROVED')
        throw new ConflictException('Application already approved');
      // If REJECTED, allow re-apply — delete old rejected application
      await this.dataSource.query(
        `DELETE FROM affiliate_applications WHERE user_id = $1`,
        [dto.userId],
      );
    }

    await this.dataSource.query(
      `INSERT INTO affiliate_applications
         (user_id, status, notes, applied_at, created_at, updated_at)
       VALUES ($1, 'PENDING', $2, NOW(), NOW(), NOW())`,
      [dto.userId, dto.notes ?? null],
    );

    return { message: 'Affiliate application submitted. Awaiting admin approval.' };
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC: record a referral-link click (best-effort, never throws)
  // ─────────────────────────────────────────────────────────────

  async recordClick(
    code: string,
    meta: {
      ip?: string;
      userAgent?: string | string[];
      referer?: string | string[];
      landingPath?: string;
    } = {},
  ) {
    if (!code || !code.trim()) return { ok: false };
    const ref = code.trim();
    try {
      // Resolve the code owner + (if any) their affiliate row. A code that
      // matches no user is still logged — useful for spotting dead links.
      const rows = await this.dataSource.query(
        `SELECT u.id AS user_id, au.id AS affiliate_user_id
           FROM users u
           LEFT JOIN affiliate_users au ON au.user_id = u.id
          WHERE u.referral_code = $1 OR u.user_code = $1
          LIMIT 1`,
        [ref],
      );
      const ownerUserId = rows.length ? rows[0].user_id : null;
      const affiliateUserId = rows.length ? rows[0].affiliate_user_id : null;

      const first = (v?: string | string[]) =>
        (Array.isArray(v) ? v[0] : v) ?? null;

      await this.dataSource.query(
        `INSERT INTO affiliate_clicks
           (referral_code, affiliate_user_id, referrer_user_id, ip, user_agent, referer, landing_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          ref,
          affiliateUserId,
          ownerUserId,
          meta.ip ?? null,
          first(meta.userAgent),
          first(meta.referer),
          meta.landingPath ?? null,
        ],
      );
      return { ok: true };
    } catch {
      // Tracking is best-effort; never propagate to the redirect.
      return { ok: false };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // USER: get my affiliate status
  // ─────────────────────────────────────────────────────────────

  async getMyAffiliateStatus(userId: number) {
    const [appRows, affiliateRows] = await Promise.all([
      this.dataSource.query(
        `SELECT id, status, notes, applied_at, decided_at, rejection_reason
         FROM affiliate_applications WHERE user_id = $1 LIMIT 1`,
        [userId],
      ),
      this.dataSource.query(
        `SELECT id, commission_pct, is_active, approved_at
         FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
        [userId],
      ),
    ]);

    const userRow = await this.dataSource.query(
      `SELECT user_code FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );

    return {
      userCode:     userRow.length ? userRow[0].user_code : null,
      isAffiliate:  affiliateRows.length > 0,
      isActive:     affiliateRows.length ? affiliateRows[0].is_active : false,
      commissionPct: affiliateRows.length ? parseFloat(affiliateRows[0].commission_pct) : 0,
      approvedAt:   affiliateRows.length ? affiliateRows[0].approved_at : null,
      application:  appRows.length ? appRows[0] : null,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // USER: get my downline (users who registered using my user_code)
  // ─────────────────────────────────────────────────────────────

async getMyDownline(userId: number, page = 1, limit = 20) {
  // Must be an active affiliate
  const affiliate = await this.dataSource.query(
    `SELECT id FROM affiliate_users WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId],
  );
  if (!affiliate.length)
    throw new ForbiddenException('You are not an active affiliate');

  const offset = (page - 1) * limit;

  const [rows, count] = await Promise.all([
    this.dataSource.query(
      `SELECT
         u.id,
         u.user_code,
         u.username,
         u.full_name,
         u.vip_level,
         u.account_status,
         vlc.level_name,
         vlc.group_name,
         vlc.badge_icon_url,
         uc.total_coins,
         uc.lifetime_coins,
         r.created_at   AS referred_at
       FROM referrals r
       JOIN users              u   ON u.id  = r.referee_user_id
       LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
       LEFT JOIN user_coins        uc  ON uc.user_id = u.id
       WHERE r.referrer_user_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    ),
    this.dataSource.query(
      `SELECT COUNT(*) AS total FROM referrals WHERE referrer_user_id = $1`,
      [userId],
    ),
  ]);

  return {
    data: rows.map((row) => ({
      id:           row.id,
      userCode:     row.user_code,
      username:     row.username,
      fullName:     row.full_name,
      accountStatus: row.account_status,
      referredAt:   row.referred_at,
      memberLevel: {
        level:       row.vip_level,
        levelName:   row.level_name   ?? 'Starter',
        groupName:   row.group_name   ?? null,
        badgeIconUrl: row.badge_icon_url ?? null,
      },
      coins: {
        totalCoins:    row.total_coins    ? parseFloat(row.total_coins)    : 0,
        lifetimeCoins: row.lifetime_coins ? parseFloat(row.lifetime_coins) : 0,
      },
    })),
    total: parseInt(count[0].total),
    page,
    limit,
  };
}

  // ─────────────────────────────────────────────────────────────
  // USER: get my referral bonus history
  // ─────────────────────────────────────────────────────────────

  async getMyReferralBonuses(userId: number, page = 1, limit = 20) {
    const affiliate = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [userId],
    );
    if (!affiliate.length)
      throw new ForbiddenException('You are not an active affiliate');

    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT
           rb.id,
           rb.amount,
           rb.source,
           rb.status,
           rb.created_at,
           rb.approved_at,
           u.username    AS referee_username,
           u.full_name   AS referee_name
         FROM referral_bonus rb
         JOIN users u ON u.id = rb.referee_user_id
         WHERE rb.referrer_user_id = $1
         ORDER BY rb.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM referral_bonus WHERE referrer_user_id = $1`,
        [userId],
      ),
    ]);

    return { data: rows, total: parseInt(count[0].total), page, limit };
  }

  // ─────────────────────────────────────────────────────────────
  // USER: get my affiliate summary stats
  // ─────────────────────────────────────────────────────────────

  async getMyAffiliateSummary(userId: number) {
    const affiliate = await this.dataSource.query(
      `SELECT id, commission_pct FROM affiliate_users WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [userId],
    );
    if (!affiliate.length)
      throw new ForbiddenException('You are not an active affiliate');

    const [totalDownline, totalBonus, pendingBonus, totalClicks] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM referrals WHERE referrer_user_id = $1`,
        [userId],
      ),
      this.dataSource.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM referral_bonus
         WHERE referrer_user_id = $1 AND status = 'APPROVED'`,
        [userId],
      ),
      this.dataSource.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM referral_bonus
         WHERE referrer_user_id = $1 AND status = 'PENDING'`,
        [userId],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM affiliate_clicks WHERE referrer_user_id = $1`,
        [userId],
      ),
    ]);

    const downlineCount = parseInt(totalDownline[0].total);
    const clicks = parseInt(totalClicks[0].total);

    return {
      commissionPct:      parseFloat(affiliate[0].commission_pct),
      totalDownlineCount: downlineCount,
      totalBonusEarned:   parseFloat(totalBonus[0].total),
      pendingBonus:       parseFloat(pendingBonus[0].total),
      totalClicks:        clicks,
      // Share of clicks that turned into a signup (sign-up conversion).
      signupConversionPct: clicks > 0 ? Math.round((downlineCount / clicks) * 1000) / 10 : 0,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN: list all pending applications
  // ─────────────────────────────────────────────────────────────

  async getPendingApplications(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT
           aa.id,
           aa.user_id,
           aa.notes,
           aa.applied_at,
           u.full_name,
           u.username,
           u.email,
           u.user_code,
           u.vip_level,
           u.created_at AS user_joined_at,
           w.total_deposited,
           w.balance
         FROM affiliate_applications aa
         JOIN users   u ON u.id = aa.user_id
         JOIN wallets w ON w.user_id = aa.user_id
         WHERE aa.status = 'PENDING'
         ORDER BY aa.applied_at ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM affiliate_applications WHERE status = 'PENDING'`,
      ),
    ]);
    return { data: rows, total: parseInt(count[0].total), page, limit };
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN: approve or reject application
  // ─────────────────────────────────────────────────────────────

  async decideApplication(dto: DecideApplicationDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const apps = await queryRunner.query(
        `SELECT * FROM affiliate_applications WHERE id = $1 LIMIT 1`,
        [dto.applicationId],
      );
      if (!apps.length) throw new NotFoundException('Application not found');

      const app = apps[0];
      if (app.status !== 'PENDING')
        throw new BadRequestException(`Application already ${app.status}`);

      if (dto.action === 'APPROVE') {
        // 1. Update application status
        await queryRunner.query(
          `UPDATE affiliate_applications
           SET status = 'APPROVED', decided_at = NOW(),
               decided_by_admin_id = $1, updated_at = NOW()
           WHERE id = $2`,
          [dto.adminId, dto.applicationId],
        );

        // Optional group assigned at approval time must exist.
        if (dto.groupId != null) {
          const g = await queryRunner.query(
            `SELECT id FROM affiliate_groups WHERE id = $1`,
            [dto.groupId],
          );
          if (!g.length) throw new NotFoundException('Group not found');
        }

        // 2. Insert into affiliate_users. The weekly engine resolves the rate
        //    as: revshare_rate override → assigned group → bracket-matched
        //    group → legacy ladder. "Assign group & approve" sets group_id.
        await queryRunner.query(
          `INSERT INTO affiliate_users
             (user_id, commission_pct, revshare_rate, group_id, is_active, status, approved_at, approved_by_admin_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, true, 'ACTIVE', NOW(), $5, NOW(), NOW())
           ON CONFLICT (user_id) DO UPDATE
           SET is_active = true,
               status = 'ACTIVE',
               commission_pct = EXCLUDED.commission_pct,
               revshare_rate = COALESCE(EXCLUDED.revshare_rate, affiliate_users.revshare_rate),
               group_id = COALESCE(EXCLUDED.group_id, affiliate_users.group_id),
               approved_by_admin_id = EXCLUDED.approved_by_admin_id,
               updated_at = NOW()`,
          [app.user_id, dto.commissionPct ?? 0, dto.revshareRate ?? null, dto.groupId ?? null, dto.adminId],
        );

        await queryRunner.commitTransaction();
        return { message: 'Application approved. User is now an affiliate.' };

      } else {
        // REJECT
        await queryRunner.query(
          `UPDATE affiliate_applications
           SET status = 'REJECTED', decided_at = NOW(),
               decided_by_admin_id = $1, rejection_reason = $2, updated_at = NOW()
           WHERE id = $3`,
          [dto.adminId, dto.rejectionReason ?? null, dto.applicationId],
        );

        await queryRunner.commitTransaction();
        return { message: 'Application rejected.' };
      }
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN: list all affiliates
  // ─────────────────────────────────────────────────────────────

  async getAllAffiliates(
    page = 1,
    limit = 20,
    filters: {
      q?: string;
      code?: string;
      tier?: number;
      status?: 'active' | 'inactive';
      from?: string;
      to?: string;
    } = {},
  ) {
    const offset = (page - 1) * limit;

    // Build the shared WHERE (applies to both the page query and the count).
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (filters.q) {
      where.push(`(u.username ILIKE $${i} OR u.email ILIKE $${i} OR u.full_name ILIKE $${i})`);
      params.push(`%${filters.q}%`);
      i++;
    }
    if (filters.code) {
      where.push(`(u.user_code ILIKE $${i} OR u.referral_code ILIKE $${i})`);
      params.push(`%${filters.code}%`);
      i++;
    }
    if (filters.tier !== undefined) {
      where.push(`au.revshare_tier = $${i}`);
      params.push(filters.tier);
      i++;
    }
    if (filters.status === 'active') where.push(`au.is_active = true`);
    else if (filters.status === 'inactive') where.push(`au.is_active = false`);
    if (filters.from) {
      where.push(`au.approved_at >= $${i}::timestamptz`);
      params.push(filters.from);
      i++;
    }
    if (filters.to) {
      // inclusive end-of-day for a YYYY-MM-DD bound
      where.push(`au.approved_at < ($${i}::date + INTERVAL '1 day')`);
      params.push(filters.to);
      i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT
           au.id,
           au.user_id,
           au.commission_pct,
           au.revshare_tier,
           au.revshare_rate,
           au.is_active,
           au.status,
           au.remark,
           au.group_id,
           g.name AS group_name,
           g.rev_share_pct AS group_rate,
           au.commission_balance,
           au.lifetime_commission,
           au.approved_at,
           u.full_name,
           u.username,
           u.email,
           u.user_code,
           u.referral_code,
           u.vip_level,
           w.total_deposited,
           w.balance,
           p.phone_number,
           (SELECT COUNT(*) FROM referrals WHERE referrer_user_id = au.user_id)      AS downline_count,
           (SELECT COUNT(DISTINCT r.referee_user_id) FROM referrals r
             WHERE r.referrer_user_id = au.user_id
               AND EXISTS (SELECT 1 FROM deposits d
                            WHERE d.user_id = r.referee_user_id AND d.status = 'APPROVED'
                              AND d.decided_at >= (CURRENT_DATE - ((EXTRACT(DOW FROM CURRENT_DATE)::int + 2) % 7))))
                                                                                     AS active_players_week,
           (SELECT COALESCE(SUM(w2.total_deposited),0) FROM referrals r2
             JOIN wallets w2 ON w2.user_id = r2.referee_user_id
            WHERE r2.referrer_user_id = au.user_id)                                  AS downline_deposits,
           (SELECT COUNT(*) FROM affiliate_clicks WHERE referrer_user_id = au.user_id) AS click_count,
           (SELECT COALESCE(SUM(amount),0) FROM referral_bonus
            WHERE referrer_user_id = au.user_id AND status = 'APPROVED')             AS total_bonus_paid
         FROM affiliate_users au
         JOIN users   u ON u.id = au.user_id
         JOIN wallets w ON w.user_id = au.user_id
         LEFT JOIN affiliate_groups g ON g.id = au.group_id
         LEFT JOIN LATERAL (
           SELECT phone_number FROM user_phone_numbers
            WHERE user_id = u.id ORDER BY is_primary DESC, id ASC LIMIT 1
         ) p ON TRUE
         ${whereSql}
         ORDER BY au.approved_at DESC
         LIMIT $${i} OFFSET $${i + 1}`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total
           FROM affiliate_users au
           JOIN users u ON u.id = au.user_id
           ${whereSql}`,
        params,
      ),
    ]);
    return { data: rows, total: parseInt(count[0].total), page, limit };
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN: update commission %
  // ─────────────────────────────────────────────────────────────

  async updateCommission(dto: UpdateCommissionDto) {
    if (dto.commissionPct < 0 || dto.commissionPct > 100)
      throw new BadRequestException('Commission must be between 0 and 100');

    const rows = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
      [dto.affiliateUserId],
    );
    if (!rows.length) throw new NotFoundException('Affiliate not found');

    await this.dataSource.query(
      `UPDATE affiliate_users
       SET commission_pct = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [dto.commissionPct, dto.affiliateUserId],
    );
    return { message: 'Commission updated' };
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN: enable / disable affiliate
  // ─────────────────────────────────────────────────────────────

  async toggleAffiliate(dto: ToggleAffiliateDto) {
    const rows = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
      [dto.affiliateUserId],
    );
    if (!rows.length) throw new NotFoundException('Affiliate not found');

    await this.dataSource.query(
      `UPDATE affiliate_users
       SET is_active = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [dto.isActive, dto.affiliateUserId],
    );
    return { message: `Affiliate ${dto.isActive ? 'enabled' : 'disabled'}` };
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN: view one affiliate's full downline
  // ─────────────────────────────────────────────────────────────

async getAffiliateDownline(affiliateUserId: number, page = 1, limit = 20) {
  const rows = await this.dataSource.query(
    `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
    [affiliateUserId],
  );
  if (!rows.length) throw new NotFoundException('Affiliate not found');

  const offset = (page - 1) * limit;
  const [data, count] = await Promise.all([
    this.dataSource.query(
      `SELECT
         u.id,
         u.user_code,
         u.full_name,
         u.username,
         u.vip_level,
         u.account_status,
         u.created_at      AS joined_at,
         r.created_at      AS referred_at,
         vlc.level_name,
         vlc.group_name,
         uc.total_coins,
         uc.lifetime_coins,
         w.total_deposited,
         w.balance
       FROM referrals r
       JOIN users              u   ON u.id  = r.referee_user_id
       JOIN wallets            w   ON w.user_id = u.id
       LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
       LEFT JOIN user_coins        uc  ON uc.user_id = u.id
       WHERE r.referrer_user_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [affiliateUserId, limit, offset],
    ),
    this.dataSource.query(
      `SELECT COUNT(*) AS total FROM referrals WHERE referrer_user_id = $1`,
      [affiliateUserId],
    ),
  ]);

  return { data, total: parseInt(count[0].total), page, limit };
}

  // ─────────────────────────────────────────────────────────────
// USER: get single downline user detail
// ─────────────────────────────────────────────────────────────

async getMyDownlineUser(affiliateUserId: number, targetUserId: number) {
  // Must be active affiliate
  const affiliate = await this.dataSource.query(
    `SELECT id FROM affiliate_users WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [affiliateUserId],
  );
  if (!affiliate.length)
    throw new ForbiddenException('You are not an active affiliate');

  // Confirm target user is actually under this affiliate
  const referral = await this.dataSource.query(
    `SELECT id FROM referrals
     WHERE referrer_user_id = $1 AND referee_user_id = $2 LIMIT 1`,
    [affiliateUserId, targetUserId],
  );
  if (!referral.length)
    throw new ForbiddenException('This user is not in your downline');

  const rows = await this.dataSource.query(
    `SELECT
       u.id,
       u.user_code,
       u.username,
       u.full_name,
       u.vip_level,
       u.account_status,
       u.created_at      AS joined_at,
       vlc.level_name,
       vlc.group_name,
       vlc.badge_icon_url,
       vlc.benefits,
       uc.total_coins,
       uc.lifetime_coins,
       r.created_at      AS referred_at
     FROM users              u
     JOIN referrals          r   ON r.referee_user_id = u.id
                                AND r.referrer_user_id = $1
     LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
     LEFT JOIN user_coins        uc  ON uc.user_id = u.id
     WHERE u.id = $2
     LIMIT 1`,
    [affiliateUserId, targetUserId],
  );

  if (!rows.length) throw new NotFoundException('User not found');

  const row = rows[0];

  // Coin history for this user — only visible to the affiliate (abstracted, no wallet)
  const coinHistory = await this.dataSource.query(
    `SELECT
       event_type,
       coins,
       balance_before,
       balance_after,
       description,
       created_at
     FROM coin_ledger
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [targetUserId],
  );

  return {
    id:            row.id,
    userCode:      row.user_code,
    username:      row.username,
    fullName:      row.full_name,
    accountStatus: row.account_status,
    joinedAt:      row.joined_at,
    referredAt:    row.referred_at,
    memberLevel: {
      level:        row.vip_level,
      levelName:    row.level_name    ?? 'Starter',
      groupName:    row.group_name    ?? null,
      badgeIconUrl: row.badge_icon_url ?? null,
      benefits:     row.benefits       ?? null,
    },
    coins: {
      totalCoins:    row.total_coins    ? parseFloat(row.total_coins)    : 0,
      lifetimeCoins: row.lifetime_coins ? parseFloat(row.lifetime_coins) : 0,
    },
    recentCoinActivity: coinHistory,
  };
}
}
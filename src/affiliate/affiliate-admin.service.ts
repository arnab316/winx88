// src/affiliate/affiliate-admin.service.ts
//
// Admin-panel operations from the Figma affiliate admin design:
//   • Affiliate groups CRUD (name, revshare %, min/max active players)
//   • Group assignment + account status (active/inactive/suspended/locked)
//   • Contact edit (name/email/phone/remark) + password reset
//   • Affiliate-scoped KYC list / decide (reuses the user verification module
//     since affiliates ARE users)
//   • Affiliate profile (user-panel "Profile" page)
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { VerificationService } from '../verification/verification.service';
import { assertPhoneAvailable } from '../common/phone.util';

// Mirrors the affiliate "Change Status" modal (ACTIVE = the only working
// state; every other value makes is_active FALSE, pausing commission/weekly
// processing). BLOCKED added to match users.account_status's full set.
const AFFILIATE_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'LOCKED', 'BLOCKED'] as const;

@Injectable()
export class AffiliateAdminService {
  constructor(
    private dataSource: DataSource,
    private verificationService: VerificationService,
  ) {}

  private fridayOfToday(): string {
    const x = new Date();
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() - 5 + 7) % 7));
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const d = String(x.getDate()).padStart(2, '0');
    return `${x.getFullYear()}-${m}-${d}`;
  }

  // ═════════════════════════════════════════════════════════════
  // GROUPS
  // ═════════════════════════════════════════════════════════════
  async listGroups() {
    const weekStart = this.fridayOfToday();
    const rows = await this.dataSource.query(
      `
      SELECT g.id, g.name, g.rev_share_pct, g.min_active_players, g.max_active_players,
             g.is_active, g.created_at, g.updated_at,
             (SELECT COUNT(*) FROM affiliate_users au WHERE au.group_id = g.id)::int AS affiliates,
             COALESCE(s.players, 0)::int        AS players,
             COALESCE(s.active_players, 0)::int AS active_players,
             COALESCE(s.player_deposits, 0)     AS player_deposits
        FROM affiliate_groups g
        LEFT JOIN LATERAL (
          SELECT COUNT(r.referee_user_id) AS players,
                 COUNT(r.referee_user_id) FILTER (WHERE EXISTS (
                   SELECT 1 FROM deposits d
                    WHERE d.user_id = r.referee_user_id AND d.status = 'APPROVED'
                      AND d.decided_at >= $1::date)) AS active_players,
                 COALESCE(SUM(w.total_deposited), 0) AS player_deposits
            FROM affiliate_users au
            JOIN referrals r ON r.referrer_user_id = au.user_id
            LEFT JOIN wallets w ON w.user_id = r.referee_user_id
           WHERE au.group_id = g.id
        ) s ON TRUE
       ORDER BY g.min_active_players ASC, g.id ASC
      `,
      [weekStart],
    );
    // Page-level KPI cards ("Affiliate groups" screen header). Counts span
    // ALL affiliates — including ones with no group assigned — so the summary
    // can exceed the sum of the group cards.
    const [s] = await this.dataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM affiliate_groups)::int                          AS total_groups,
         (SELECT COUNT(*) FROM affiliate_users)::int                           AS total_affiliates,
         (SELECT COUNT(*) FROM affiliate_applications
           WHERE status = 'PENDING')::int                                      AS pending_applications,
         (SELECT COUNT(*) FROM referrals r
           JOIN affiliate_users au ON au.user_id = r.referrer_user_id)::int    AS total_players,
         (SELECT COALESCE(SUM(w.total_deposited), 0) FROM referrals r
           JOIN affiliate_users au ON au.user_id = r.referrer_user_id
           JOIN wallets w ON w.user_id = r.referee_user_id)                    AS total_deposits`,
    );

    return {
      summary: {
        totalGroups:         s.total_groups,
        totalAffiliates:     s.total_affiliates,
        pendingApplications: s.pending_applications,
        totalPlayers:        s.total_players,
        totalDeposits:       parseFloat(s.total_deposits),
      },
      groups: rows.map((g: any) => ({
        id: Number(g.id),
        name: g.name,
        revSharePct: parseFloat(g.rev_share_pct),
        minActivePlayers: g.min_active_players,
        maxActivePlayers: g.max_active_players,
        isActive: g.is_active,
        affiliates: g.affiliates,
        players: g.players,
        activePlayers: g.active_players,
        playerDeposits: parseFloat(g.player_deposits),
        createdAt: g.created_at,
        updatedAt: g.updated_at,
      })),
    };
  }

  private validateGroupFields(dto: {
    revSharePct?: number;
    minActivePlayers?: number;
    maxActivePlayers?: number | null;
  }) {
    if (dto.revSharePct !== undefined &&
        (!Number.isFinite(dto.revSharePct) || dto.revSharePct < 0 || dto.revSharePct > 100)) {
      throw new BadRequestException('revSharePct must be between 0 and 100');
    }
    if (dto.minActivePlayers !== undefined &&
        (!Number.isInteger(dto.minActivePlayers) || dto.minActivePlayers < 0)) {
      throw new BadRequestException('minActivePlayers must be a non-negative integer');
    }
    if (dto.maxActivePlayers != null &&
        (!Number.isInteger(dto.maxActivePlayers) || dto.maxActivePlayers < 0)) {
      throw new BadRequestException('maxActivePlayers must be a non-negative integer or null');
    }
  }

  async createGroup(
    dto: { name: string; revSharePct: number; minActivePlayers?: number; maxActivePlayers?: number | null },
    adminId: number,
  ) {
    if (!dto.name?.trim()) throw new BadRequestException('name is required');
    if (dto.revSharePct === undefined) throw new BadRequestException('revSharePct is required');
    this.validateGroupFields(dto);
    const min = dto.minActivePlayers ?? 0;
    const max = dto.maxActivePlayers ?? null;
    if (max != null && max < min) {
      throw new BadRequestException('maxActivePlayers must be >= minActivePlayers');
    }
    try {
      const rows = await this.dataSource.query(
        `INSERT INTO affiliate_groups
           (name, rev_share_pct, min_active_players, max_active_players, created_by_admin_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [dto.name.trim(), dto.revSharePct, min, max, adminId],
      );
      return { message: 'Group created', group: rows[0] };
    } catch (e: any) {
      if (e.code === '23505') throw new ConflictException(`Group "${dto.name.trim()}" already exists`);
      throw e;
    }
  }

  async updateGroup(
    id: number,
    dto: { name?: string; revSharePct?: number; minActivePlayers?: number; maxActivePlayers?: number | null; isActive?: boolean },
  ) {
    const existing = await this.dataSource.query(
      `SELECT * FROM affiliate_groups WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Group not found');
    this.validateGroupFields(dto);

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw new BadRequestException('name cannot be empty');
      fields.push(`name = $${i++}`);
      values.push(dto.name.trim());
    }
    if (dto.revSharePct !== undefined) { fields.push(`rev_share_pct = $${i++}`); values.push(dto.revSharePct); }
    if (dto.minActivePlayers !== undefined) { fields.push(`min_active_players = $${i++}`); values.push(dto.minActivePlayers); }
    if (dto.maxActivePlayers !== undefined) { fields.push(`max_active_players = $${i++}`); values.push(dto.maxActivePlayers); }
    if (dto.isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(dto.isActive === true); }
    if (!fields.length) throw new BadRequestException('Nothing to update');

    const min = dto.minActivePlayers ?? existing[0].min_active_players;
    const max = dto.maxActivePlayers !== undefined ? dto.maxActivePlayers : existing[0].max_active_players;
    if (max != null && max < min) {
      throw new BadRequestException('maxActivePlayers must be >= minActivePlayers');
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);
    try {
      // UPDATE ... RETURNING via dataSource.query yields [records, affectedCount].
      const [records] = await this.dataSource.query(
        `UPDATE affiliate_groups SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        values,
      );
      return { message: 'Group updated', group: records[0] };
    } catch (e: any) {
      if (e.code === '23505') throw new ConflictException(`Group name already in use`);
      throw e;
    }
  }

  async deleteGroup(id: number) {
    const [records] = await this.dataSource.query(
      `DELETE FROM affiliate_groups WHERE id = $1 RETURNING name`,
      [id],
    );
    if (!records.length) throw new NotFoundException('Group not found');
    // group_id FK is ON DELETE SET NULL — members simply lose the assignment.
    return { message: `Group "${records[0].name}" deleted` };
  }

  /** Assign / clear an affiliate's group (by the affiliate's users.id). */
  async assignGroup(userId: number, groupId: number | null) {
    const af = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!af.length) throw new NotFoundException('Affiliate not found');
    if (groupId != null) {
      const g = await this.dataSource.query(
        `SELECT id, name FROM affiliate_groups WHERE id = $1`,
        [groupId],
      );
      if (!g.length) throw new NotFoundException('Group not found');
    }
    if (groupId != null) {
      // Client rule: assigning a group makes the affiliate TRACK that group's
      // revshare. Clear any per-affiliate override (revshare_rate → NULL) so
      // resolveRate() falls through to the group's CURRENT rate — and stays in
      // sync if the group rate is later edited. A manual override can still be
      // re-applied afterward via the revshare endpoint.
      await this.dataSource.query(
        `UPDATE affiliate_users
            SET group_id = $1, revshare_rate = NULL, updated_at = NOW()
          WHERE user_id = $2`,
        [groupId, userId],
      );
    } else {
      // Clearing the group leaves any manual override untouched.
      await this.dataSource.query(
        `UPDATE affiliate_users SET group_id = NULL, updated_at = NOW() WHERE user_id = $1`,
        [userId],
      );
    }
    return { message: groupId != null ? 'Group assigned' : 'Group cleared' };
  }

  // ═════════════════════════════════════════════════════════════
  // ACCOUNT STATUS / CONTACT / PASSWORD (admin detail page)
  // ═════════════════════════════════════════════════════════════
  async updateStatus(userId: number, status: string, remark?: string) {
    const s = String(status ?? '').toUpperCase();
    if (!AFFILIATE_STATUSES.includes(s as any)) {
      throw new BadRequestException(`status must be one of: ${AFFILIATE_STATUSES.join(', ')}`);
    }
    const [records] = await this.dataSource.query(
      `UPDATE affiliate_users
          SET status = $1,
              is_active = $2,
              remark = COALESCE($3, remark),
              updated_at = NOW()
        WHERE user_id = $4
        RETURNING id, status, is_active, remark`,
      [s, s === 'ACTIVE', remark ?? null, userId],
    );
    if (!records.length) throw new NotFoundException('Affiliate not found');
    return { message: 'Account status updated', affiliate: records[0] };
  }

  async updateContact(
    userId: number,
    dto: { fullName?: string; email?: string; phone?: string; remark?: string },
  ) {
    const af = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!af.length) throw new NotFoundException('Affiliate not found');

    const userFields: string[] = [];
    const userValues: any[] = [];
    let i = 1;
    if (dto.fullName !== undefined) { userFields.push(`full_name = $${i++}`); userValues.push(dto.fullName); }
    if (dto.email !== undefined) { userFields.push(`email = $${i++}`); userValues.push(dto.email); }
    if (userFields.length) {
      userFields.push(`updated_at = NOW()`);
      userValues.push(userId);
      try {
        await this.dataSource.query(
          `UPDATE users SET ${userFields.join(', ')} WHERE id = $${i}`,
          userValues,
        );
      } catch (e: any) {
        if (e.code === '23505') throw new ConflictException('Email already in use');
        throw e;
      }
    }

    if (dto.phone !== undefined && dto.phone !== null) {
      const existing = await this.dataSource.query(
        `SELECT id FROM user_phone_numbers WHERE user_id = $1
          ORDER BY is_primary DESC, id ASC LIMIT 1`,
        [userId],
      );
      // Same one-number-one-account rule as the member routes: never let an
      // affiliate edit take over a number that belongs to another account.
      await assertPhoneAvailable(this.dataSource, dto.phone, {
        excludePhoneId: existing.length ? existing[0].id : undefined,
        message: 'Phone number already registered to another account',
      });
      if (existing.length) {
        await this.dataSource.query(
          `UPDATE user_phone_numbers SET phone_number = $1, updated_at = NOW() WHERE id = $2`,
          [dto.phone, existing[0].id],
        );
      } else {
        await this.dataSource.query(
          `INSERT INTO user_phone_numbers (user_id, phone_number, is_primary, is_verified)
           VALUES ($1, $2, TRUE, FALSE)`,
          [userId, dto.phone],
        );
      }
    }

    if (dto.remark !== undefined) {
      await this.dataSource.query(
        `UPDATE affiliate_users SET remark = $1, updated_at = NOW() WHERE user_id = $2`,
        [dto.remark || null, userId],
      );
    }

    return { message: 'Contact information saved' };
  }

  async changePassword(userId: number, newPassword: string) {
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters');
    }
    const af = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!af.length) throw new NotFoundException('Affiliate not found');

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.dataSource.query(
      `UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2`,
      [hashed, userId],
    );
    return { message: 'Password changed successfully' };
  }

  // ═════════════════════════════════════════════════════════════
  // AFFILIATE-SCOPED KYC (reuses user_verifications / verification module)
  // ═════════════════════════════════════════════════════════════
  // Affiliate-side KYC = approved affiliates PLUS pending partner applicants
  // (someone who signed up on the portal and submitted KYC before approval).
  // Exact mirror of the NOT-affiliate exclusion on /verification/admin/list,
  // so every verification appears in exactly ONE of the two admin views.
  private static readonly IS_AFFILIATE_SQL = `
    (EXISTS (SELECT 1 FROM affiliate_users au WHERE au.user_id = uv.user_id)
     OR EXISTS (SELECT 1 FROM affiliate_applications aa
                 WHERE aa.user_id = uv.user_id AND aa.status = 'PENDING'))`;

  async listAffiliateVerifications(page = 1, limit = 20, status?: string) {
    const offset = (page - 1) * limit;
    const params: any[] = [];
    let where = `WHERE ${AffiliateAdminService.IS_AFFILIATE_SQL}`;
    if (status) {
      params.push(status.toUpperCase());
      where += ` AND uv.status = $1`;
    }

    const [rows, count, stats] = await Promise.all([
      this.dataSource.query(
        `SELECT uv.id, uv.user_id, u.username, u.full_name, u.user_code,
                uv.document_type, uv.document_number, uv.expiry_date,
                uv.front_image_url, uv.back_image_url, uv.selfie_image_url,
                uv.status, uv.rejection_reason, uv.submission_count,
                uv.reviewed_at,
                adm.name  AS decided_by_name,
                adm.email AS decided_by_email,
                uv.created_at, uv.updated_at
           FROM user_verifications uv
           JOIN users u ON u.id = uv.user_id
           LEFT JOIN admin_users adm ON adm.id = uv.reviewed_by_admin_id
           ${where}
           ORDER BY (uv.status = 'PENDING') DESC, uv.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total
           FROM user_verifications uv
           ${where}`,
        params,
      ),
      this.dataSource.query(
        `SELECT
           COUNT(*) FILTER (WHERE uv.status IN ('PENDING','UNDER_REVIEW'))::int AS pending,
           COUNT(*) FILTER (WHERE uv.status = 'APPROVED')::int AS approved,
           COUNT(*) FILTER (WHERE uv.status = 'REJECTED')::int AS rejected
         FROM user_verifications uv
         WHERE ${AffiliateAdminService.IS_AFFILIATE_SQL}`,
      ),
    ]);

    return { stats: stats[0], data: rows, total: count[0].total, page, limit };
  }

  async decideAffiliateVerification(
    verificationId: number,
    adminId: number,
    action: 'APPROVE' | 'REJECT',
    rejectionReason?: string,
  ) {
    // Guard: only verifications belonging to affiliates are decidable here.
    const rows = await this.dataSource.query(
      `SELECT uv.id
         FROM user_verifications uv
         JOIN affiliate_users au ON au.user_id = uv.user_id
        WHERE uv.id = $1 LIMIT 1`,
      [verificationId],
    );
    if (!rows.length) {
      throw new NotFoundException('Verification not found for any affiliate');
    }
    return this.verificationService.reviewVerification(
      verificationId,
      adminId,
      action,
      rejectionReason,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // AFFILIATE-FACING: profile (user-panel "Profile" page)
  // ═════════════════════════════════════════════════════════════
  async getMyProfile(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT u.id, u.user_code, u.username, u.full_name, u.email, u.referral_code,
              u.created_at AS user_joined_at,
              au.status, au.is_active, au.commission_pct, au.revshare_rate,
              au.commission_balance, au.lifetime_commission, au.approved_at,
              au.group_id, g.name AS group_name, g.rev_share_pct AS group_rate,
              p.phone_number,
              uv.status AS kyc_status
         FROM affiliate_users au
         JOIN users u ON u.id = au.user_id
         LEFT JOIN affiliate_groups g ON g.id = au.group_id
         LEFT JOIN LATERAL (
           SELECT phone_number FROM user_phone_numbers
            WHERE user_id = u.id ORDER BY is_primary DESC, id ASC LIMIT 1
         ) p ON TRUE
         LEFT JOIN user_verifications uv ON uv.user_id = u.id
        WHERE au.user_id = $1
        LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new ForbiddenException('You are not an affiliate');
    const r = rows[0];
    const rate =
      r.revshare_rate != null
        ? parseFloat(r.revshare_rate)
        : r.group_rate != null
          ? parseFloat(r.group_rate)
          : null;
    return {
      userId: Number(r.id),
      fullName: r.full_name,
      username: r.username,
      email: r.email,
      phone: r.phone_number ?? null,
      // AFFILIATE code = user_code — the code the tracking link, dashboard, and
      // downline attribution (attachAffiliateOnSignup / admin edit-user) all
      // match on. referral_code (ANIKHA00AY-style) is the SEPARATE
      // refer-a-friend code and must NOT be shown as the affiliate code, or
      // it fails when pasted into "put user under affiliate".
      affiliateCode: r.user_code,
      userCode: r.user_code,
      commissionRate: rate,
      group: r.group_id != null ? { id: Number(r.group_id), name: r.group_name } : null,
      memberSince: r.approved_at ?? r.user_joined_at,
      status: r.status,
      kycStatus: r.kyc_status ?? 'NOT_SUBMITTED',
      commissionBalance: parseFloat(r.commission_balance),
      lifetimeCommission: parseFloat(r.lifetime_commission),
    };
  }
}

// src/vip/vip.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CoinLedgerService } from '../ledger/coin-ledger.service';
import {
  CreateVipLevelConfigDto,
  UpdateVipLevelConfigDto,
  AdminSetVipLevelDto,
  UpdateTierLimitsDto,
  SetTierBanksDto,
} from './dto/vip.dto';

// coins_required is NUMERIC(14,4): the integer part has at most 10 digits,
// so values must stay strictly below 10^10.
const COINS_REQUIRED_MAX = 9_999_999_999;

// Sentinel threshold for invitation-only tiers: the column max, so points can
// never auto-reach them. (invitation_only = TRUE already excludes them from the
// auto-promote query — this is just belt-and-suspenders.)
const INVITE_ONLY_SENTINEL = COINS_REQUIRED_MAX;

/**
 * Single Responsibility: manage users.vip_level + vip_level_config CRUD.
 *
 * Promotion rule (per Q3 of design): when a user's lifetime_coins crosses
 * a threshold, auto-promote them to the highest level they qualify for.
 *
 * Demotion rule: NEVER demote based on coin loss. Lifetime coins only
 * go up. Admin can manually demote via adminSetLevel() if needed.
 */
@Injectable()
export class VipService {
  constructor(
    private dataSource: DataSource,
    private coinLedger: CoinLedgerService,
  ) {}

  // ═════════════════════════════════════════════════════════════
  // CHECK LEVEL UP — called from CoinService after every credit
  //
  //   Idempotent: if already at correct level, does nothing.
  //   Atomic: uses caller's QueryRunner (same transaction).
  // ═════════════════════════════════════════════════════════════
  async checkLevelUp(
    qr: QueryRunner,
    userId: number,
    lifetimeCoins: number,
  ): Promise<{ leveledUp: boolean; oldLevel: number; newLevel: number }> {
    // 1. Current level (lock the row to prevent concurrent updates)
    const userRows = await qr.query(
      `SELECT vip_level FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!userRows.length) {
      throw new NotFoundException('User not found');
    }
    const oldLevel = Number(userRows[0].vip_level);

    // 2. Find highest level the user qualifies for.
    //    Invitation-only tiers (Grandmaster/Legend/Mythic, §4.5) are NEVER
    //    reached automatically — they are granted by hand via adminSetLevel().
    const eligibleRows = await qr.query(
      `SELECT level FROM vip_level_config
       WHERE coins_required <= $1
         AND invitation_only = FALSE
       ORDER BY level DESC
       LIMIT 1`,
      [lifetimeCoins],
    );
    const newLevel = eligibleRows.length ? Number(eligibleRows[0].level) : 0;

    // 3. If already at correct level (or higher — never demote), exit early
    if (newLevel <= oldLevel) {
      return { leveledUp: false, oldLevel, newLevel: oldLevel };
    }

    // 4. Promote
    await qr.query(
      `UPDATE users SET vip_level = $1, updated_at = NOW() WHERE id = $2`,
      [newLevel, userId],
    );

    // 5. Audit row in coin_ledger (LEVEL_UP event, 0 coin change)
    //    user_coins.total_coins balance is unchanged here, so before==after.
    const balRow = await qr.query(
      `SELECT total_coins FROM user_coins WHERE user_id = $1`,
      [userId],
    );
    const bal = balRow.length ? parseFloat(balRow[0].total_coins) : 0;

    await this.coinLedger.write({
      qr,
      userId,
      eventType:     'LEVEL_UP',
      coins:         0,
      balanceBefore: bal,
      balanceAfter:  bal,
      referenceType: 'LEVEL',
      referenceId:   newLevel,
      description:   `Promoted from level ${oldLevel} to ${newLevel}`,
    });

    return { leveledUp: true, oldLevel, newLevel };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: SET USER LEVEL (manual override)
  //   Can promote OR demote. Use case: support corrections, fraud demotion.
  // ═════════════════════════════════════════════════════════════
  async adminSetLevel(dto: AdminSetVipLevelDto, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // 1. Verify the requested level exists in config
      const lvl = await qr.query(
        `SELECT level, level_name FROM vip_level_config WHERE level = $1`,
        [dto.level],
      );
      if (!lvl.length) {
        throw new BadRequestException(`Level ${dto.level} not configured`);
      }

      // 2. Lock + read current
      const userRows = await qr.query(
        `SELECT vip_level FROM users WHERE id = $1 FOR UPDATE`,
        [dto.userId],
      );
      if (!userRows.length) throw new NotFoundException('User not found');

      const oldLevel = Number(userRows[0].vip_level);
      if (oldLevel === dto.level) {
        await qr.commitTransaction();
        return { message: 'Already at that level', oldLevel, newLevel: dto.level };
      }

      // 3. Update
      await qr.query(
        `UPDATE users SET vip_level = $1, updated_at = NOW() WHERE id = $2`,
        [dto.level, dto.userId],
      );

      // 4. Audit
      const balRow = await qr.query(
        `SELECT COALESCE(total_coins, 0) AS bal FROM user_coins WHERE user_id = $1`,
        [dto.userId],
      );
      const bal = balRow.length ? parseFloat(balRow[0].bal) : 0;

      await this.coinLedger.write({
        qr,
        userId:        dto.userId,
        eventType:     'LEVEL_UP',
        coins:         0,
        balanceBefore: bal,
        balanceAfter:  bal,
        referenceType: 'ADMIN',
        referenceId:   adminId,
        description:   `Admin override: ${oldLevel} → ${dto.level}. Reason: ${dto.reason}`,
      });

      await qr.commitTransaction();
      return {
        message:     'VIP level updated',
        oldLevel,
        newLevel:    dto.level,
        levelName:   lvl[0].level_name,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // QUERIES
  // ═════════════════════════════════════════════════════════════
  async getMyVip(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT
          u.vip_level,
          vc.level_name,
          vc.group_name,
          vc.coins_required AS current_threshold,
          vc.benefits,
          vc.badge_icon_url,
          vc.ui_color,
          COALESCE(uc.lifetime_coins, 0) AS lifetime_coins,
          COALESCE(uc.total_coins, 0)    AS total_coins
       FROM users u
       LEFT JOIN vip_level_config vc ON vc.level = u.vip_level
       LEFT JOIN user_coins uc       ON uc.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('User not found');

    const me = rows[0];
    const currentLevelNo = Number(me.vip_level);
    const lifetime = parseFloat(me.lifetime_coins);
    const currentThreshold = me.current_threshold
      ? parseFloat(me.current_threshold)
      : 0;

    // The full ladder — used both for the next-tier calc and the UI list.
    const all = await this.dataSource.query(
      `SELECT level, level_name, group_name, coins_required,
              badge_icon_url, ui_color, invitation_only, status
       FROM vip_level_config
       ORDER BY level ASC`,
    );

    // Next AUTOMATIC tier (invitation-only tiers can't be reached by coins).
    const nextRow = all.find(
      (l: any) => Number(l.level) > currentLevelNo && l.invitation_only === false,
    );

    let nextLevel: any = null;
    let progress: any;
    if (nextRow) {
      const nextThreshold = parseFloat(nextRow.coins_required);
      // Band-relative progress: earned + remaining = target.
      const target = Math.max(1, nextThreshold - currentThreshold);
      const earned = Math.max(0, lifetime - currentThreshold);
      const remaining = Math.max(0, nextThreshold - lifetime);
      const percent = Math.min(100, Math.max(0, Math.round((earned / target) * 100)));

      nextLevel = {
        level:         Number(nextRow.level),
        levelName:     nextRow.level_name,
        groupName:     nextRow.group_name,
        coinsRequired: nextThreshold,
        badgeIconUrl:  nextRow.badge_icon_url,
        uiColor:       nextRow.ui_color,
      };
      progress = {
        coinsEarned:    earned,          // "XP EARNED"  (within current band)
        coinsRemaining: remaining,       // "XP REMAINING"
        coinsTarget:    nextThreshold - currentThreshold, // "XP TARGET" (band size)
        percent,                         // progress-bar fill %
        lifetimeCoins:  lifetime,
        currentThreshold,
        nextThreshold,
      };
    } else {
      // Top automatic tier reached — full bar, nothing left to earn.
      progress = {
        coinsEarned:    Math.max(0, lifetime - currentThreshold),
        coinsRemaining: 0,
        coinsTarget:    0,
        percent:        100,
        lifetimeCoins:  lifetime,
        currentThreshold,
        nextThreshold:  null,
      };
    }

    // Full ladder with a per-row status the UI can render directly:
    //   CURRENT (you are here) / ACHIEVED (passed) / OPEN (reachable by coins)
    //   / INVITATION (invite-only, not yet granted)
    const levels = all.map((l: any) => {
      const lvl = Number(l.level);
      const invitationOnly = l.invitation_only === true;
      let status: string;
      if (lvl === currentLevelNo) status = 'CURRENT';
      else if (lvl < currentLevelNo) status = 'ACHIEVED';
      else if (invitationOnly) status = 'INVITATION';
      else status = 'OPEN';

      return {
        level:         lvl,
        levelName:     l.level_name,
        groupName:     l.group_name,
        coinsRequired: parseFloat(l.coins_required),
        badgeIconUrl:  l.badge_icon_url,
        uiColor:       l.ui_color,
        invitationOnly,
        isCurrent:     lvl === currentLevelNo,
        achieved:      lvl <= currentLevelNo,
        status,
      };
    });

    return {
      currentLevel: {
        level:        currentLevelNo,
        levelName:    me.level_name,
        groupName:    me.group_name,
        benefits:     me.benefits,
        badgeIconUrl: me.badge_icon_url,
        uiColor:      me.ui_color,
      },
      lifetimeCoins: lifetime,
      totalCoins:    parseFloat(me.total_coins),
      nextLevel,
      progress,
      levels,
    };
  }

  async getAllLevels() {
    const rows = await this.dataSource.query(
      `SELECT level, level_name, group_name, coins_required,
              badge_icon_url, benefits
       FROM vip_level_config
       ORDER BY level ASC`,
    );
    // Normalise to camelCase + numeric so it matches /vip/me and the frontend
    // can read coinsRequired directly (DB returns NUMERIC as a string).
    return rows.map((r: any) => ({
      level:        Number(r.level),
      levelName:    r.level_name,
      groupName:    r.group_name,
      coinsRequired: Number(r.coins_required),
      badgeIconUrl: r.badge_icon_url,
      benefits:     r.benefits,
    }));
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CONFIG CRUD
  // ═════════════════════════════════════════════════════════════
  async getConfig() {
    return this.dataSource.query(
      `SELECT * FROM vip_level_config ORDER BY level ASC`,
    );
  }

  // POST /vip/admin/config — create a new VIP level / tier
  async createLevel(dto: CreateVipLevelConfigDto) {
    const dupe = await this.dataSource.query(
      `SELECT level FROM vip_level_config WHERE level = $1`,
      [dto.level],
    );
    if (dupe.length) {
      throw new BadRequestException(`Level ${dto.level} already exists`);
    }

    const invitationOnly = dto.invitationOnly ?? false;

    // Automatic tiers need a real points threshold; invitation-only tiers use
    // the unreachable sentinel so the auto-promote query never selects them.
    let coinsRequired: number;
    if (invitationOnly) {
      coinsRequired = INVITE_ONLY_SENTINEL;
    } else {
      if (dto.coinsRequired === undefined) {
        throw new BadRequestException(
          'coinsRequired is required for automatic (non invitation-only) tiers',
        );
      }
      if (dto.coinsRequired > COINS_REQUIRED_MAX) {
        throw new BadRequestException(
          `coinsRequired must be at most ${COINS_REQUIRED_MAX}`,
        );
      }
      coinsRequired = dto.coinsRequired;
    }

    try {
      const result = await this.dataSource.query(
        `INSERT INTO vip_level_config
           (level, level_name, group_name, coins_required, invitation_only,
            sequence, ui_color, status, currency, badge_icon_url, benefits)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'ACTIVE'),COALESCE($9,'BDT'),$10,$11)
         RETURNING *`,
        [
          dto.level,
          dto.levelName,
          dto.groupName ?? dto.levelName,
          coinsRequired,
          invitationOnly,
          dto.sequence ?? dto.level,
          dto.uiColor ?? null,
          dto.status ?? null,
          dto.currency ?? null,
          dto.badgeIconUrl ?? null,
          dto.benefits ? JSON.stringify(dto.benefits) : null,
        ],
      );
      return result[0];
    } catch (e: any) {
      // Unique violation (race on the level PK)
      if (e?.code === '23505') {
        throw new BadRequestException(`Level ${dto.level} already exists`);
      }
      throw e;
    }
  }

  // DELETE /vip/admin/config/:level — remove a VIP level / tier
  //   Guards: cannot delete the default tier, and cannot delete a tier that
  //   still has players assigned (reassign them first). tier_banks rows are
  //   removed automatically via ON DELETE CASCADE.
  async deleteLevel(level: number) {
    const existing = await this.dataSource.query(
      `SELECT level, is_default FROM vip_level_config WHERE level = $1`,
      [level],
    );
    if (!existing.length) {
      throw new NotFoundException(`Level ${level} not configured`);
    }
    if (existing[0].is_default) {
      throw new BadRequestException(
        'Cannot delete the default tier. Set another tier as default first.',
      );
    }

    const inUse = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE vip_level = $1`,
      [level],
    );
    if (inUse[0].n > 0) {
      throw new BadRequestException(
        `Cannot delete: ${inUse[0].n} player(s) are currently in this tier. Reassign them first.`,
      );
    }

    await this.dataSource.query(
      `DELETE FROM vip_level_config WHERE level = $1`,
      [level],
    );
    return { message: `Level ${level} deleted`, level };
  }

  async updateConfig(level: number, dto: UpdateVipLevelConfigDto) {
    const existing = await this.dataSource.query(
      `SELECT * FROM vip_level_config WHERE level = $1`,
      [level],
    );
    if (!existing.length) {
      throw new NotFoundException(`Level ${level} not configured`);
    }

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    const map: Record<string, any> = {
      // identity
      level_name:     dto.levelName,
      group_name:     dto.groupName,
      coins_required: dto.coinsRequired,
      badge_icon_url: dto.badgeIconUrl,
      benefits:       dto.benefits ? JSON.stringify(dto.benefits) : undefined,
      // presentation / status
      ui_color:       dto.uiColor,
      sequence:       dto.sequence,
      status:         dto.status,
      currency:       dto.currency,
      invitation_only: dto.invitationOnly,
      // banking-side limits
      deposit_min:            dto.depositMin,
      deposit_max:            dto.depositMax,
      balance_below:          dto.balanceBelow,
      withdrawal_min:         dto.withdrawalMin,
      withdrawal_max:         dto.withdrawalMax,
      withdrawal_daily_count: dto.withdrawalDailyCount,
      withdrawal_daily_max:   dto.withdrawalDailyMax,
      withdrawal_turnover:    dto.withdrawalTurnover,
      allow_clear_balance:    dto.allowClearBalance,
      auto_clear_turnover:    dto.autoClearTurnover,
      internal_remark:        dto.internalRemark,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(level);

    const result = await this.dataSource.query(
      `UPDATE vip_level_config SET ${fields.join(', ')}
       WHERE level = $${i} RETURNING *`,
      values,
    );
    return result[0];
  }

  // ═════════════════════════════════════════════════════════════
  // TIER SYSTEM (Member Group / banking-side view of the same tiers)
  // ═════════════════════════════════════════════════════════════

  // GET /tiers/public — ladder for the dashboard (no auth)
  async getPublicLadder() {
    return this.dataSource.query(
      `SELECT level, level_name, group_name, coins_required,
              invitation_only, ui_color, sequence, cached_player_count, badge_icon_url
         FROM vip_level_config
        WHERE status = 'ACTIVE'
        ORDER BY sequence ASC, level ASC`,
    );
  }

  // GET /tiers/admin — all tiers with banking-side fields
  async getTiersAdmin() {
    return this.dataSource.query(
      `SELECT * FROM vip_level_config ORDER BY sequence ASC, level ASC`,
    );
  }

  // PATCH /tiers/admin/:level/limits — banking limits (Member Group screen)
  async updateTierLimits(level: number, dto: UpdateTierLimitsDto) {
    const existing = await this.dataSource.query(
      `SELECT level FROM vip_level_config WHERE level = $1`,
      [level],
    );
    if (!existing.length) throw new NotFoundException(`Tier ${level} not configured`);

    const map: Record<string, any> = {
      deposit_min:            dto.depositMin,
      deposit_max:            dto.depositMax,
      balance_below:          dto.balanceBelow,
      withdrawal_min:         dto.withdrawalMin,
      withdrawal_max:         dto.withdrawalMax,
      withdrawal_daily_count: dto.withdrawalDailyCount,
      withdrawal_daily_max:   dto.withdrawalDailyMax,
      withdrawal_turnover:    dto.withdrawalTurnover,
      allow_clear_balance:    dto.allowClearBalance,
      auto_clear_turnover:    dto.autoClearTurnover,
      internal_remark:        dto.internalRemark,
      invitation_only:        dto.invitationOnly,
      ui_color:               dto.uiColor,
      sequence:               dto.sequence,
      status:                 dto.status,
      currency:               dto.currency,
    };

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(level);
    const result = await this.dataSource.query(
      `UPDATE vip_level_config SET ${fields.join(', ')} WHERE level = $${i} RETURNING *`,
      values,
    );
    return result[0];
  }

  // GET /tiers/admin/:level/banks — allowed payment channels
  async getTierBanks(level: number) {
    return this.dataSource.query(
      `SELECT id, level, channel, enabled FROM tier_banks WHERE level = $1 ORDER BY channel`,
      [level],
    );
  }

  // PUT /tiers/admin/:level/banks — replace the full channel set
  async setTierBanks(level: number, dto: SetTierBanksDto) {
    const tier = await this.dataSource.query(
      `SELECT level FROM vip_level_config WHERE level = $1`,
      [level],
    );
    if (!tier.length) throw new NotFoundException(`Tier ${level} not configured`);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`DELETE FROM tier_banks WHERE level = $1`, [level]);
      for (const ch of dto.channels) {
        await qr.query(
          `INSERT INTO tier_banks (level, channel, enabled) VALUES ($1, $2, $3)`,
          [level, ch.channel, ch.enabled ?? true],
        );
      }
      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
    return this.getTierBanks(level);
  }

  // POST /tiers/admin/:level/set-default — fallback tier for new players
  async setDefaultTier(level: number) {
    const tier = await this.dataSource.query(
      `SELECT level FROM vip_level_config WHERE level = $1`,
      [level],
    );
    if (!tier.length) throw new NotFoundException(`Tier ${level} not configured`);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`UPDATE vip_level_config SET is_default = FALSE WHERE is_default = TRUE`);
      await qr.query(`UPDATE vip_level_config SET is_default = TRUE WHERE level = $1`, [level]);
      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
    return { message: `Tier ${level} is now the default`, level };
  }

  // GET /vip/admin/users/:level — players currently in a tier
  async getUsersInTier(level: number, page = 1, limit = 50) {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const offset = (Math.max(page, 1) - 1) * safeLimit;
    const data = await this.dataSource.query(
      `SELECT u.id, u.user_code, u.username, u.full_name, u.vip_level,
              COALESCE(uc.lifetime_coins, 0) AS lifetime_coins
         FROM users u
         LEFT JOIN user_coins uc ON uc.user_id = u.id
        WHERE u.vip_level = $1
        ORDER BY uc.lifetime_coins DESC NULLS LAST
        LIMIT $2 OFFSET $3`,
      [level, safeLimit, offset],
    );
    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM users WHERE vip_level = $1`,
      [level],
    );
    return { data, page, limit: safeLimit, total: count[0].total };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: ALL USERS BY VIP LEVEL (every tier in one list)
  //   Sorted by vip_level then lifetime coins. Optional ?level= filter
  //   and ?search= (username / full_name / user_code).
  // ═════════════════════════════════════════════════════════════
  async getAllUsersByLevel(
    page = 1,
    limit = 50,
    level?: number,
    search?: string,
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safePage = Math.max(page, 1);
    const offset = (safePage - 1) * safeLimit;

    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (level !== undefined) {
      where.push(`u.vip_level = $${i++}`);
      params.push(level);
    }
    if (search?.trim()) {
      where.push(
        `(u.username ILIKE $${i} OR u.full_name ILIKE $${i} OR u.user_code ILIKE $${i})`,
      );
      params.push(`%${search.trim()}%`);
      i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const data = await this.dataSource.query(
      `SELECT u.id, u.user_code, u.username, u.full_name,
              u.vip_level,
              vc.level_name,
              vc.group_name,
              COALESCE(uc.lifetime_coins, 0) AS lifetime_coins,
              COALESCE(uc.total_coins, 0)    AS total_coins
         FROM users u
         LEFT JOIN vip_level_config vc ON vc.level = u.vip_level
         LEFT JOIN user_coins uc        ON uc.user_id = u.id
         ${whereSql}
         ORDER BY u.vip_level DESC, lifetime_coins DESC, u.id ASC
         LIMIT $${i} OFFSET $${i + 1}`,
      [...params, safeLimit, offset],
    );

    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM users u ${whereSql}`,
      params,
    );

    return {
      data,
      page: safePage,
      limit: safeLimit,
      total: count[0].total,
      totalPages: Math.ceil(count[0].total / safeLimit) || 0,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // CRON: refresh cached_player_count per tier (build-guide §4.6)
  //   Runs daily at midnight server time. Not real-time by design.
  // ═════════════════════════════════════════════════════════════
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async refreshCachedPlayerCounts(): Promise<void> {
    await this.dataSource.query(`
      UPDATE vip_level_config vc
         SET cached_player_count = COALESCE(c.cnt, 0)
        FROM (
          SELECT vip_level, COUNT(*)::bigint AS cnt
            FROM users
           WHERE account_status = 'ACTIVE'
           GROUP BY vip_level
        ) c
       WHERE c.vip_level = vc.level;
    `);
    // Tiers with zero players won't match above — reset them to 0 explicitly.
    await this.dataSource.query(`
      UPDATE vip_level_config vc
         SET cached_player_count = 0
       WHERE NOT EXISTS (
         SELECT 1 FROM users u
          WHERE u.vip_level = vc.level AND u.account_status = 'ACTIVE'
       );
    `);
  }
}
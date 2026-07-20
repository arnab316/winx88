// src/vip/vip.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CoinLedgerService } from '../ledger/coin-ledger.service';
import { WalletGateway } from '../wallet/wallet.gateway';
import {
  CreateVipLevelConfigDto,
  UpdateVipLevelConfigDto,
  AdminSetVipLevelDto,
  UpdateTierLimitsDto,
  CreateMemberGroupDto,
  UpdateMemberGroupDto,
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
    // forwardRef: VipModule → WalletModule → CoinsModule → VipModule cycle.
    @Inject(forwardRef(() => WalletGateway))
    private readonly walletGateway: WalletGateway,
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

  // GET /vip/admin/stats — dashboard summary cards
  //   totalPlayers     : all users
  //   vipLevels        : configured tiers
  //   automaticLevels  : tiers reachable by points (invitation_only = FALSE)
  //   invitationOnly   : invite-only tiers (invitation_only = TRUE)
  async getDashboardStats() {
    const [players] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM users`,
    );
    const [levels] = await this.dataSource.query(
      `SELECT
         COUNT(*)::int                                          AS total,
         COUNT(*) FILTER (WHERE invitation_only = FALSE)::int   AS automatic,
         COUNT(*) FILTER (WHERE invitation_only = TRUE)::int    AS invitation
       FROM vip_level_config`,
    );

    return {
      totalPlayers:    players.n,
      vipLevels:       levels.total,
      automaticLevels: levels.automatic,
      invitationOnly:  levels.invitation,
    };
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

  // POST /tiers/admin — create a member group / tier WITH banking limits
  //   (name, level, currency, withdrawal limits, status, default). Same
  //   coins_required rules as createLevel: invitation-only tiers use the
  //   unreachable sentinel; automatic tiers require coinsRequired.
  async createMemberGroup(dto: CreateMemberGroupDto) {
    const dupe = await this.dataSource.query(
      `SELECT level FROM vip_level_config WHERE level = $1`,
      [dto.level],
    );
    if (dupe.length) {
      throw new BadRequestException(`Level ${dto.level} already exists`);
    }

    const invitationOnly = dto.invitationOnly ?? false;
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

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const res = await qr.query(
        `INSERT INTO vip_level_config
           (level, level_name, group_name, coins_required, invitation_only,
            sequence, status, currency, ui_color, badge_icon_url, benefits,
            deposit_min, deposit_max, balance_below,
            withdrawal_min, withdrawal_max, withdrawal_daily_count, withdrawal_daily_max,
            withdrawal_turnover, allow_clear_balance, auto_clear_turnover, internal_remark)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'ACTIVE'),COALESCE($8,'BDT'),$9,$10,$11,
                 $12,$13,$14,$15,$16,$17,$18,$19,
                 COALESCE($20,FALSE),COALESCE($21,FALSE),$22)
         RETURNING *`,
        [
          dto.level,
          dto.name,
          dto.groupName ?? dto.name,
          coinsRequired,
          invitationOnly,
          dto.sequence ?? dto.level,
          dto.status ?? null,
          dto.currency ?? null,
          dto.uiColor ?? null,
          dto.badgeIconUrl ?? null,
          dto.benefits ? JSON.stringify(dto.benefits) : null,
          dto.depositMin ?? null,
          dto.depositMax ?? null,
          dto.balanceBelow ?? null,
          dto.withdrawalMin ?? null,
          dto.withdrawalMax ?? null,
          dto.withdrawalDailyCount ?? null,
          dto.withdrawalDailyMax ?? null,
          dto.withdrawalTurnover ?? null,
          dto.allowClearBalance ?? null,
          dto.autoClearTurnover ?? null,
          dto.internalRemark ?? null,
        ],
      );
      let row = res[0];

      if (dto.isDefault === true) {
        await qr.query(`UPDATE vip_level_config SET is_default = FALSE WHERE is_default = TRUE`);
        const upd = await qr.query(
          `UPDATE vip_level_config SET is_default = TRUE, updated_at = NOW()
           WHERE level = $1 RETURNING *`,
          [dto.level],
        );
        row = upd[0];
      }

      await qr.commitTransaction();
      return { message: 'Member group created', tier: row };
    } catch (e: any) {
      await qr.rollbackTransaction();
      if (e?.code === '23505') {
        throw new BadRequestException(`Level ${dto.level} already exists`);
      }
      throw e;
    } finally {
      await qr.release();
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

  // GET /tiers/admin/member-groups — the Member Group withdrawal-limits table,
  //   grouped by currency. Columns mirror the admin screen: name, withdrawal
  //   min/max, daily count, daily max, default setting, status.
  async getMemberGroupList() {
    const rows = await this.dataSource.query(
      `SELECT level, level_name, group_name, coins_required, invitation_only,
              sequence, ui_color, badge_icon_url, benefits, is_default, status,
              COALESCE(currency, 'BDT') AS currency,
              deposit_min, deposit_max, balance_below,
              withdrawal_min, withdrawal_max,
              withdrawal_daily_count, withdrawal_daily_max, withdrawal_turnover,
              allow_clear_balance, auto_clear_turnover, internal_remark
         FROM vip_level_config
        ORDER BY COALESCE(currency, 'BDT') ASC, sequence ASC, level ASC`,
    );

    const num = (v: any) => (v === null || v === undefined ? null : Number(v));
    const groups: Record<string, any> = {};
    for (const r of rows) {
      const cur = r.currency;
      if (!groups[cur]) groups[cur] = { currency: cur, tiers: [] };
      groups[cur].tiers.push({
        level:                Number(r.level),
        name:                 r.level_name,
        groupName:            r.group_name,
        coinsRequired:        num(r.coins_required),
        invitationOnly:       r.invitation_only === true,
        sequence:             num(r.sequence),
        uiColor:              r.ui_color,
        badgeIconUrl:         r.badge_icon_url,
        benefits:             r.benefits,
        depositMin:           num(r.deposit_min),
        depositMax:           num(r.deposit_max),
        balanceBelow:         num(r.balance_below),
        withdrawalMin:        num(r.withdrawal_min),
        withdrawalMax:        num(r.withdrawal_max),
        withdrawalDailyCount: num(r.withdrawal_daily_count),
        withdrawalDailyMax:   num(r.withdrawal_daily_max),
        withdrawalTurnover:   num(r.withdrawal_turnover),
        allowClearBalance:    r.allow_clear_balance === true,
        autoClearTurnover:    r.auto_clear_turnover === true,
        internalRemark:       r.internal_remark,
        isDefault:            r.is_default === true,
        status:               r.status,
      });
    }
    return Object.values(groups);
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

  // PATCH /tiers/admin/:level — edit a member group (one call for the whole
  //   "Action" edit row): name, withdrawal limits, status, currency, and the
  //   default flag. Setting isDefault=true atomically moves the default here.
  async updateMemberGroup(level: number, dto: UpdateMemberGroupDto) {
    const existing = await this.dataSource.query(
      `SELECT level FROM vip_level_config WHERE level = $1`,
      [level],
    );
    if (!existing.length) throw new NotFoundException(`Tier ${level} not configured`);

    const map: Record<string, any> = {
      level_name:             dto.name,
      group_name:             dto.groupName,
      coins_required:         dto.coinsRequired,
      invitation_only:        dto.invitationOnly,
      sequence:               dto.sequence,
      ui_color:               dto.uiColor,
      badge_icon_url:         dto.badgeIconUrl,
      benefits:               dto.benefits ? JSON.stringify(dto.benefits) : undefined,
      status:                 dto.status,
      currency:               dto.currency,
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

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const fields: string[] = [];
      const values: any[] = [];
      let i = 1;
      for (const [col, val] of Object.entries(map)) {
        if (val !== undefined) {
          fields.push(`${col} = $${i++}`);
          values.push(val);
        }
      }

      let row: any;
      if (fields.length) {
        fields.push(`updated_at = NOW()`);
        values.push(level);
        const res = await qr.query(
          `UPDATE vip_level_config SET ${fields.join(', ')} WHERE level = $${i} RETURNING *`,
          values,
        );
        row = res[0];
      }

      // Default flag: only act on an explicit true (moving the default here).
      if (dto.isDefault === true) {
        await qr.query(`UPDATE vip_level_config SET is_default = FALSE WHERE is_default = TRUE`);
        const res = await qr.query(
          `UPDATE vip_level_config SET is_default = TRUE, updated_at = NOW()
           WHERE level = $1 RETURNING *`,
          [level],
        );
        row = res[0];
      }

      if (!row) {
        await qr.rollbackTransaction();
        throw new BadRequestException('No fields to update');
      }

      await qr.commitTransaction();
      return { message: 'Member group updated', tier: row };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // GET /tiers/admin/:level/banks — allowed payment channels
  async getTierBanks(level: number) {
    return this.dataSource.query(
      `SELECT id, level, channel, enabled, deposit_enabled, withdrawal_enabled
         FROM tier_banks WHERE level = $1 ORDER BY channel`,
      [level],
    );
  }

  // ═════════════════════════════════════════════════════════════
  // TIER BANKING TOGGLES — the "10 toggle buttons" per member group:
  //   2 master switches (deposit / withdrawal for the whole tier) +
  //   deposit/withdrawal per payment channel (bKash, Nagad, Rocket, Upay).
  //   Channels come from payment_gateways names (WinyPay excluded), so a
  //   newly added gateway shows up automatically defaulting to enabled.
  // ═════════════════════════════════════════════════════════════

  // GET /tiers/admin/:level/banking
  async getBankingToggles(level: number) {
    const tierRows = await this.dataSource.query(
      `SELECT level, level_name, group_name, deposit_enabled, withdrawal_enabled
         FROM vip_level_config WHERE level = $1`,
      [level],
    );
    if (!tierRows.length) throw new NotFoundException(`Tier ${level} not configured`);
    const tier = tierRows[0];

    const channels = await this.dataSource.query(
      `SELECT g.name AS channel,
              COALESCE(tb.enabled, TRUE)            AS enabled,
              COALESCE(tb.deposit_enabled, TRUE)    AS deposit_enabled,
              COALESCE(tb.withdrawal_enabled, TRUE) AS withdrawal_enabled
         FROM (SELECT DISTINCT name FROM payment_gateways
                WHERE LOWER(name) <> 'winypay') g
         LEFT JOIN tier_banks tb ON tb.level = $1 AND tb.channel = g.name
        ORDER BY g.name`,
      [level],
    );

    return {
      level: tier.level,
      levelName: tier.level_name,
      groupName: tier.group_name,
      depositEnabled: tier.deposit_enabled,
      withdrawalEnabled: tier.withdrawal_enabled,
      channels: channels.map((c: any) => ({
        channel: c.channel,
        depositEnabled: c.enabled && c.deposit_enabled,
        withdrawalEnabled: c.enabled && c.withdrawal_enabled,
      })),
    };
  }

  // PATCH /tiers/admin/:level/banking
  async updateBankingToggles(
    level: number,
    dto: {
      depositEnabled?: boolean;
      withdrawalEnabled?: boolean;
      channels?: { channel: string; depositEnabled?: boolean; withdrawalEnabled?: boolean }[];
    },
  ) {
    const tier = await this.dataSource.query(
      `SELECT level FROM vip_level_config WHERE level = $1`,
      [level],
    );
    if (!tier.length) throw new NotFoundException(`Tier ${level} not configured`);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      if (dto.depositEnabled !== undefined || dto.withdrawalEnabled !== undefined) {
        await qr.query(
          `UPDATE vip_level_config
              SET deposit_enabled    = COALESCE($1, deposit_enabled),
                  withdrawal_enabled = COALESCE($2, withdrawal_enabled),
                  updated_at = NOW()
            WHERE level = $3`,
          [dto.depositEnabled ?? null, dto.withdrawalEnabled ?? null, level],
        );
      }

      for (const ch of dto.channels ?? []) {
        // Upsert per channel; flipping a direction re-enables the legacy
        // overall `enabled` flag so the new pair is the single source of truth.
        await qr.query(
          `INSERT INTO tier_banks (level, channel, enabled, deposit_enabled, withdrawal_enabled)
           VALUES ($1, $2, TRUE, COALESCE($3, TRUE), COALESCE($4, TRUE))
           ON CONFLICT (level, channel) DO UPDATE SET
             enabled            = TRUE,
             deposit_enabled    = COALESCE($3, tier_banks.deposit_enabled),
             withdrawal_enabled = COALESCE($4, tier_banks.withdrawal_enabled)`,
          [level, ch.channel, ch.depositEnabled ?? null, ch.withdrawalEnabled ?? null],
        );
      }

      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }

    // Push the fresh effective state to every connected user of this tier so
    // open deposit/withdraw pages re-render live ('banking:toggles' on /wallet).
    const fresh = await this.getBankingToggles(level);
    this.walletGateway.pushBankingToggles(level, fresh);
    return fresh;
  }

  // Effective toggles for a specific user (deposit page / withdraw page).
  async getMyBankingToggles(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT vip_level FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('User not found');
    return this.getBankingToggles(rows[0].vip_level);
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

  // GET /vip/admin/users/:level — players in a tier (or ALL tiers if level is
  //   undefined). Full member-group list: currency, member group, member ID,
  //   user ID, name, primary mobile, email, referrer, affiliate, status, level.
  //   Filters: ?search= (username / member ID / name / email / mobile /
  //   referrer) and a registered date range ?dateFrom=&dateTo= (YYYY-MM-DD,
  //   inclusive).
  async getUsersInTier(
    level: number | undefined,
    page = 1,
    limit = 50,
    search?: string,
    dateFrom?: string,
    dateTo?: string,
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safePage = Math.max(page, 1);
    const offset = (safePage - 1) * safeLimit;

    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    // Omit the level filter to search across ALL levels.
    if (level !== undefined) {
      where.push(`u.vip_level = $${i++}`);
      params.push(level);
    }

    if (search?.trim()) {
      // Combination search: one term matched across username, member ID, name,
      // email, primary/any mobile, and the referrer (their code/username/name).
      where.push(
        `(u.username ILIKE $${i}
          OR u.user_code ILIKE $${i}
          OR u.full_name ILIKE $${i}
          OR u.email ILIKE $${i}
          OR EXISTS (SELECT 1 FROM user_phone_numbers p
                      WHERE p.user_id = u.id AND p.phone_number ILIKE $${i})
          OR EXISTS (SELECT 1 FROM users r
                      WHERE r.id = u.referred_by_user_id
                        AND (r.user_code ILIKE $${i}
                             OR r.username ILIKE $${i}
                             OR r.full_name ILIKE $${i})))`,
      );
      params.push(`%${search.trim()}%`);
      i++;
    }
    if (dateFrom?.trim()) {
      where.push(`u.created_at >= $${i}::date`);
      params.push(dateFrom.trim());
      i++;
    }
    if (dateTo?.trim()) {
      // inclusive of the whole end day
      where.push(`u.created_at < ($${i}::date + 1)`);
      params.push(dateTo.trim());
      i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await this.dataSource.query(
      `SELECT
          u.id, u.user_code, u.username, u.full_name, u.email,
          u.account_status, u.created_at, u.vip_level,
          COALESCE(uc.lifetime_coins, 0)   AS lifetime_coins,
          COALESCE(vc.currency, 'BDT')     AS currency,
          vc.level_name                    AS level_name,
          vc.group_name                    AS member_group,
          ph.phone_number                  AS mobile,
          ref.id                           AS referrer_id,
          ref.user_code                    AS referrer_code,
          ref.username                     AS referrer_username,
          ref.full_name                    AS referrer_name,
          (au.id IS NOT NULL)              AS referrer_is_affiliate
        FROM users u
        LEFT JOIN user_coins uc       ON uc.user_id = u.id
        LEFT JOIN vip_level_config vc ON vc.level = u.vip_level
        LEFT JOIN users ref           ON ref.id = u.referred_by_user_id
        LEFT JOIN affiliate_users au  ON au.user_id = u.referred_by_user_id AND au.is_active = true
        LEFT JOIN LATERAL (
          SELECT phone_number FROM user_phone_numbers
           WHERE user_id = u.id
           ORDER BY is_primary DESC, is_verified DESC, id ASC
           LIMIT 1
        ) ph ON true
        ${whereSql}
        ORDER BY u.vip_level DESC, uc.lifetime_coins DESC NULLS LAST, u.id ASC
        LIMIT $${i} OFFSET $${i + 1}`,
      [...params, safeLimit, offset],
    );
    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM users u ${whereSql}`,
      params,
    );

    const data = rows.map((u: any) => {
      const referrer = u.referrer_id
        ? {
            userId:   Number(u.referrer_id),
            memberId: u.referrer_code,
            name:     u.referrer_name ?? u.referrer_username,
          }
        : null;
      return {
        currency:       u.currency ?? 'BDT',
        memberGroup:    u.member_group,
        memberId:       u.user_code,
        userId:         Number(u.id),
        username:       u.username,
        name:           u.full_name,
        mobile:         u.mobile ?? null,
        email:          u.email,
        referrer,
        // Affiliate = the referring affiliate (the referrer, only when that
        // referrer is an active affiliate). Null otherwise.
        affiliate:      u.referrer_is_affiliate ? referrer : null,
        registeredDate: u.created_at,
        status:         u.account_status,
        vipLevel:       Number(u.vip_level),
        levelName:      u.level_name,
        lifetimeCoins:  Number(u.lifetime_coins),
      };
    });

    const total = count[0].total;
    return {
      data,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit) || 0,
    };
  }

  // GET /vip/admin/levels/summary — every tier with its player count
  //   The "grouped by level" overview: level, level_name, group_name + count.
  async getLevelsUserCounts() {
    const rows = await this.dataSource.query(
      `SELECT vc.level, vc.level_name, vc.group_name, vc.invitation_only,
              COUNT(u.id)::int AS user_count
         FROM vip_level_config vc
         LEFT JOIN users u ON u.vip_level = vc.level
        GROUP BY vc.level, vc.level_name, vc.group_name, vc.invitation_only
        ORDER BY vc.level ASC`,
    );
    return rows.map((r: any) => ({
      level:          Number(r.level),
      levelName:      r.level_name,
      groupName:      r.group_name,
      invitationOnly: r.invitation_only,
      userCount:      r.user_count,
    }));
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: ALL USERS BY VIP LEVEL (every tier in one list)
  //   Sorted by vip_level then lifetime coins. Optional ?level= filter
  //   and ?search= (username / full_name / user_code).
  // ═════════════════════════════════════════════════════════════
  //   Delegates to getUsersInTier (level optional) so the all-levels list has
  //   the same rich fields, combined search, and date-range filter.
  async getAllUsersByLevel(
    page = 1,
    limit = 50,
    level?: number,
    search?: string,
    dateFrom?: string,
    dateTo?: string,
  ) {
    return this.getUsersInTier(level, page, limit, search, dateFrom, dateTo);
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
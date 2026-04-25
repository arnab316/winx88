// src/vip/vip.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { CoinLedgerService } from '../ledger/coin-ledger.service';
import {
  UpdateVipLevelConfigDto,
  AdminSetVipLevelDto,
} from './dto/vip.dto';

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

    // 2. Find highest level the user qualifies for
    const eligibleRows = await qr.query(
      `SELECT level FROM vip_level_config
       WHERE coins_required <= $1
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
          COALESCE(uc.lifetime_coins, 0) AS lifetime_coins,
          COALESCE(uc.total_coins, 0)    AS total_coins
       FROM users u
       LEFT JOIN vip_level_config vc ON vc.level = u.vip_level
       LEFT JOIN user_coins uc       ON uc.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('User not found');

    // Compute progress to next level
    const nextRows = await this.dataSource.query(
      `SELECT level, level_name, coins_required
       FROM vip_level_config
       WHERE level > $1
       ORDER BY level ASC
       LIMIT 1`,
      [rows[0].vip_level],
    );

    const lifetime = parseFloat(rows[0].lifetime_coins);
    const currentThreshold = rows[0].current_threshold
      ? parseFloat(rows[0].current_threshold)
      : 0;

    let nextLevel: any = null;
    if (nextRows.length) {
      const nt = parseFloat(nextRows[0].coins_required);
      nextLevel = {
        level:           Number(nextRows[0].level),
        levelName:       nextRows[0].level_name,
        coinsRequired:   nt,
        coinsRemaining:  Math.max(0, nt - lifetime),
        progressPercent: Math.min(
          100,
          Math.round(
            ((lifetime - currentThreshold) /
              Math.max(1, nt - currentThreshold)) * 100,
          ),
        ),
      };
    }

    return {
      currentLevel: {
        level:        Number(rows[0].vip_level),
        levelName:    rows[0].level_name,
        groupName:    rows[0].group_name,
        benefits:     rows[0].benefits,
        badgeIconUrl: rows[0].badge_icon_url,
      },
      lifetimeCoins: lifetime,
      totalCoins:    parseFloat(rows[0].total_coins),
      nextLevel,
    };
  }

  async getAllLevels() {
    return this.dataSource.query(
      `SELECT level, level_name, group_name, coins_required,
              badge_icon_url, benefits
       FROM vip_level_config
       ORDER BY level ASC`,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CONFIG CRUD
  // ═════════════════════════════════════════════════════════════
  async getConfig() {
    return this.dataSource.query(
      `SELECT * FROM vip_level_config ORDER BY level ASC`,
    );
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
      level_name:     dto.levelName,
      group_name:     dto.groupName,
      coins_required: dto.coinsRequired,
      badge_icon_url: dto.badgeIconUrl,
      benefits:       dto.benefits ? JSON.stringify(dto.benefits) : undefined,
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
}
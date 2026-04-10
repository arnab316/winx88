import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreditCoinsParams, UpdateCoinSettingsDto, UpsertVipLevelDto } from './dto';

@Injectable()
export class CoinsService {
  constructor(private dataSource: DataSource) {}

  // ─── PRIVATE: credit coins + check level-up ──────────────────────────────

  async creditCoins(queryRunner: any, p: CreditCoinsParams) {
    // 1. Get or create user_coins row
    let rows = await queryRunner.query(
      `SELECT * FROM user_coins WHERE user_id = $1 FOR UPDATE`,
      [p.userId],
    );

    if (!rows.length) {
      await queryRunner.query(
        `INSERT INTO user_coins (user_id, total_coins, lifetime_coins)
         VALUES ($1, 0, 0)`,
        [p.userId],
      );
      rows = await queryRunner.query(
        `SELECT * FROM user_coins WHERE user_id = $1 FOR UPDATE`,
        [p.userId],
      );
    }

    const coinRow      = rows[0];
    const balBefore    = parseFloat(coinRow.total_coins);
    const lifetimeBefore = parseFloat(coinRow.lifetime_coins);
    const balAfter     = balBefore + p.coinsToCredit;
    const lifetimeAfter = lifetimeBefore + p.coinsToCredit;

    // 2. Update user_coins
    await queryRunner.query(
      `UPDATE user_coins
       SET total_coins = $1, lifetime_coins = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [balAfter, lifetimeAfter, p.userId],
    );

    // 3. Write coin_ledger entry
    await queryRunner.query(
      `INSERT INTO coin_ledger
         (user_id, event_type, coins, balance_before, balance_after,
          reference_type, reference_id, description, created_at)
       VALUES ($1, 'DEPOSIT_REWARD', $2, $3, $4, $5, $6, $7, NOW())`,
      [
        p.userId,
        p.coinsToCredit,
        balBefore,
        balAfter,
        p.referenceType,
        p.referenceId,
        p.description,
      ],
    );

    // 4. Check for level-up using lifetime_coins
    await this.checkAndLevelUp(queryRunner, p.userId, lifetimeAfter);

    return { coinsEarned: p.coinsToCredit, newBalance: balAfter };
  }

  // ─── PRIVATE: auto level-up ──────────────────────────────────────────────

  private async checkAndLevelUp(
    queryRunner: any,
    userId: number,
    lifetimeCoins: number,
  ) {
    // Get user's current vip_level
    const userRows = await queryRunner.query(
      `SELECT vip_level FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) return;

    const currentLevel: number = userRows[0].vip_level;

    // Find the highest level the user now qualifies for
    const levels = await queryRunner.query(
      `SELECT level FROM vip_level_config
       WHERE coins_required <= $1 AND level > $2
       ORDER BY level DESC
       LIMIT 1`,
      [lifetimeCoins, currentLevel],
    );

    if (!levels.length) return; // no upgrade available

    const newLevel: number = levels[0].level;

    // Update vip_level on users table
    await queryRunner.query(
      `UPDATE users SET vip_level = $1, updated_at = NOW() WHERE id = $2`,
      [newLevel, userId],
    );

    // Write a level-up coin_ledger entry for record
    const coinRow = await queryRunner.query(
      `SELECT total_coins FROM user_coins WHERE user_id = $1`,
      [userId],
    );
    const bal = coinRow.length ? parseFloat(coinRow[0].total_coins) : 0;

    await queryRunner.query(
      `INSERT INTO coin_ledger
         (user_id, event_type, coins, balance_before, balance_after,
          reference_type, reference_id, description, created_at)
       VALUES ($1, 'LEVEL_UP', 0, $2, $2, 'VIP_LEVEL', $3,
               $4, NOW())`,
      [
        userId,
        bal,
        newLevel,
        `Level up! Reached level ${newLevel}`,
      ],
    );
  }

  // ─── COMPUTE coins for a deposit amount ──────────────────────────────────

  async computeCoinsForDeposit(amount: number): Promise<number> {
    const settings = await this.dataSource.query(
      `SELECT * FROM coin_settings WHERE is_active = true ORDER BY id DESC LIMIT 1`,
    );
    if (!settings.length) return 0;

    const s = settings[0];
    const minDeposit = parseFloat(s.min_deposit_amount);
    const maxDeposit = s.max_deposit_amount ? parseFloat(s.max_deposit_amount) : null;

    if (amount < minDeposit) return 0;
    if (maxDeposit && amount > maxDeposit) return 0;

    const unit  = parseFloat(s.deposit_unit);
    const rate  = parseFloat(s.coins_per_unit);
    const coins = Math.floor(amount / unit) * rate;

    return coins;
  }

  // ─── USER: get my coins + level ──────────────────────────────────────────

  async getMyCoinSummary(userId: number) {
    const [coinRows, userRows] = await Promise.all([
      this.dataSource.query(
        `SELECT total_coins, lifetime_coins FROM user_coins WHERE user_id = $1`,
        [userId],
      ),
      this.dataSource.query(
        `SELECT vip_level FROM users WHERE id = $1`,
        [userId],
      ),
    ]);

    const totalCoins   = coinRows.length ? parseFloat(coinRows[0].total_coins)    : 0;
    const lifetimeCoins = coinRows.length ? parseFloat(coinRows[0].lifetime_coins) : 0;
    const currentLevel  = userRows.length ? userRows[0].vip_level : 0;

    // Get current level config
    const currentLevelConfig = await this.dataSource.query(
      `SELECT * FROM vip_level_config WHERE level = $1`,
      [currentLevel],
    );

    // Get next level config
    const nextLevelConfig = await this.dataSource.query(
      `SELECT * FROM vip_level_config WHERE level = $1`,
      [currentLevel + 1],
    );

    const nextLevel     = nextLevelConfig.length ? nextLevelConfig[0] : null;
    const coinsToNext   = nextLevel
      ? Math.max(0, parseFloat(nextLevel.coins_required) - lifetimeCoins)
      : 0;

    return {
      totalCoins,
      lifetimeCoins,
      currentLevel,
      currentLevelName: currentLevelConfig.length ? currentLevelConfig[0].level_name : 'Starter',
      nextLevel: nextLevel
        ? {
            level:          nextLevel.level,
            levelName:      nextLevel.level_name,
            coinsRequired:  parseFloat(nextLevel.coins_required),
            coinsStillNeeded: coinsToNext,
          }
        : null,
    };
  }

  // ─── USER: coin ledger history ────────────────────────────────────────────

  async getCoinHistory(userId: number, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT id, event_type, coins, balance_before, balance_after,
                reference_type, reference_id, description, created_at
         FROM coin_ledger
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM coin_ledger WHERE user_id = $1`,
        [userId],
      ),
    ]);
    return { data: rows, total: parseInt(count[0].total), page, limit };
  }

  // ─── ADMIN: get coin settings ─────────────────────────────────────────────

  async getCoinSettings() {
    const rows = await this.dataSource.query(
      `SELECT * FROM coin_settings ORDER BY id DESC LIMIT 1`,
    );
    if (!rows.length) throw new NotFoundException('Coin settings not found');
    return rows[0];
  }

  // ─── ADMIN: update coin settings ─────────────────────────────────────────

  async updateCoinSettings(dto: UpdateCoinSettingsDto) {
    if (dto.coinsPerUnit <= 0) throw new BadRequestException('coins_per_unit must be > 0');
    if (dto.depositUnit  <= 0) throw new BadRequestException('deposit_unit must be > 0');

    await this.dataSource.query(
      `UPDATE coin_settings
       SET coins_per_unit     = $1,
           deposit_unit       = $2,
           min_deposit_amount = $3,
           max_deposit_amount = $4,
           updated_by_admin_id = $5,
           updated_at         = NOW()
       WHERE id = (SELECT id FROM coin_settings ORDER BY id DESC LIMIT 1)`,
      [
        dto.coinsPerUnit,
        dto.depositUnit,
        dto.minDepositAmount,
        dto.maxDepositAmount ?? null,
        dto.adminId,
      ],
    );
    return { message: 'Coin settings updated' };
  }

  // ─── ADMIN: list all vip levels ───────────────────────────────────────────

  async getAllVipLevels() {
    return this.dataSource.query(
      `SELECT * FROM vip_level_config ORDER BY level ASC`,
    );
  }

  // ─── ADMIN: upsert a vip level ────────────────────────────────────────────

  async upsertVipLevel(dto: UpsertVipLevelDto) {
    if (dto.level < 0 || dto.level > 7)
      throw new BadRequestException('Level must be between 0 and 7');

    await this.dataSource.query(
      `INSERT INTO vip_level_config
         (level, level_name, group_name, coins_required, badge_icon_url, benefits, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (level) DO UPDATE
       SET level_name     = EXCLUDED.level_name,
           group_name     = EXCLUDED.group_name,
           coins_required = EXCLUDED.coins_required,
           badge_icon_url = EXCLUDED.badge_icon_url,
           benefits       = EXCLUDED.benefits,
           updated_at     = NOW()`,
      [
        dto.level,
        dto.levelName,
        dto.groupName     ?? null,
        dto.coinsRequired,
        dto.badgeIconUrl  ?? null,
        dto.benefits ? JSON.stringify(dto.benefits) : null,
      ],
    );
    return { message: `VIP level ${dto.level} saved` };
  }
}
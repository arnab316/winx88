// src/coin/coin.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { CoinLedgerService } from '../ledger/coin-ledger.service';
import { VipService } from '../vip/vip.service';
import { AdminAdjustCoinsDto, UpdateCoinSettingsDto } from './dto/index';

interface CoinsAwardResult {
  awarded: number;
  newTotal: number;
  newLifetime: number;
}

/**
 * Single Responsibility: manage user_coins balance + coin_settings.
 *
 * Does NOT touch wallets. Does NOT decide VIP levels — only NOTIFIES
 * VipService after a coin credit so it can check for level-ups.
 *
 * All write methods accept a QueryRunner so they participate in the
 * caller's transaction (deposit approval, admin adjust, etc.).
 */
@Injectable()
export class CoinsService {
  constructor(
    private dataSource: DataSource,
    private coinLedger: CoinLedgerService,
    // Circular: Coin → VIP (after credit, check level-up)
    //          VIP doesn't depend on Coin, so no circular issue here, but
    //          we keep forwardRef as defensive scaffolding for future use.
    @Inject(forwardRef(() => VipService))
    private vipService: VipService,
  ) {}

  // ═════════════════════════════════════════════════════════════
  // AWARD COINS — called from deposit approval
  // ═════════════════════════════════════════════════════════════
  async awardForDeposit(
    qr: QueryRunner,
    userId: number,
    depositAmount: number,
    depositId: number,
  ): Promise<CoinsAwardResult | null> {
    // 1. Load active settings
    const settingsRows = await qr.query(
      `SELECT * FROM coin_settings WHERE is_active = true ORDER BY id DESC LIMIT 1`,
    );
    if (!settingsRows.length) {
      // No active rule → silently skip (admin hasn't enabled coins yet)
      return null;
    }
    const s = settingsRows[0];
    const coinsPerUnit = parseFloat(s.coins_per_unit);
    const depositUnit  = parseFloat(s.deposit_unit);
    const minDeposit   = parseFloat(s.min_deposit_amount);
    const maxDeposit   = s.max_deposit_amount ? parseFloat(s.max_deposit_amount) : null;

    // 2. Eligibility
    if (depositAmount < minDeposit) return null;
    if (maxDeposit !== null && depositAmount > maxDeposit) return null;

    // 3. Calculate coins (floor — no fractional units of credit)
    //    Example: 100 deposit_unit, 10 coins_per_unit, 250 deposit
    //             → floor(250 / 100) * 10 = 20 coins
    const coins = Math.floor(depositAmount / depositUnit) * coinsPerUnit;
    if (coins <= 0) return null;

    // 4. UPSERT user_coins (lock the row to prevent races)
    //    user_coins should have a row per user. Created on first credit.
    const result = await this.creditCoins(qr, userId, coins, {
      eventType:     'DEPOSIT_REWARD',
      referenceType: 'DEPOSIT',
      referenceId:   depositId,
      description:   `Earned ${coins} coins for deposit of ৳${depositAmount}`,
    });

    // 5. Trigger VIP check (auto level-up on threshold cross)
    await this.vipService.checkLevelUp(qr, userId, result.newLifetime);

    return result;
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN ADJUST — credit or debit any user's coins
  // ═════════════════════════════════════════════════════════════
  async adminAdjustCoins(dto: AdminAdjustCoinsDto, adminId: number) {
    if (dto.amount === 0) {
      throw new BadRequestException('amount cannot be zero');
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      let result: CoinsAwardResult;

      if (dto.amount > 0) {
        result = await this.creditCoins(qr, dto.userId, dto.amount, {
          eventType:     'ADMIN_ADJUST',
          referenceType: 'ADMIN',
          referenceId:   adminId,
          description:   `Admin credit: ${dto.reason}`,
        });
      } else {
        result = await this.debitCoins(qr, dto.userId, Math.abs(dto.amount), {
          eventType:     'ADMIN_ADJUST',
          referenceType: 'ADMIN',
          referenceId:   adminId,
          description:   `Admin debit: ${dto.reason}`,
        });
      }

      // Re-check VIP — debits could in theory drop someone below threshold,
      // but our policy is "never demote on coin loss"; only PROMOTE on gain.
      // checkLevelUp() handles that asymmetry internally.
      if (dto.amount > 0) {
        await this.vipService.checkLevelUp(qr, dto.userId, result.newLifetime);
      }

      await qr.commitTransaction();
      return {
        message: `Coins adjusted by ${dto.amount}`,
        ...result,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PRIVATE: CREDIT  (lifetime_coins also bumps)
  // ═════════════════════════════════════════════════════════════
  private async creditCoins(
    qr: QueryRunner,
    userId: number,
    coins: number,
    ledgerCtx: {
      eventType: 'DEPOSIT_REWARD' | 'ADMIN_ADJUST';
      referenceType?: string;
      referenceId?: number;
      description?: string;
    },
  ): Promise<CoinsAwardResult> {
    // Verify user exists (FK is on user_coins not enforced cross-row)
    const u = await qr.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    if (!u.length) throw new NotFoundException('User not found');

    // Lock or create the user_coins row
    const existing = await qr.query(
      `SELECT id, total_coins, lifetime_coins
       FROM user_coins WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );

    let totalBefore: number;
    let lifetimeBefore: number;

    if (existing.length) {
      totalBefore    = parseFloat(existing[0].total_coins);
      lifetimeBefore = parseFloat(existing[0].lifetime_coins);
    } else {
      totalBefore    = 0;
      lifetimeBefore = 0;
      // Insert empty row first so the UPDATE below works uniformly
      await qr.query(
        `INSERT INTO user_coins (user_id, total_coins, lifetime_coins)
         VALUES ($1, 0, 0)`,
        [userId],
      );
    }

    const newTotal    = totalBefore + coins;
    const newLifetime = lifetimeBefore + coins;

    await qr.query(
      `UPDATE user_coins
       SET total_coins = $1, lifetime_coins = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [newTotal, newLifetime, userId],
    );

    await this.coinLedger.write({
      qr,
      userId,
      eventType:     ledgerCtx.eventType,
      coins,
      balanceBefore: totalBefore,
      balanceAfter:  newTotal,
      referenceType: ledgerCtx.referenceType,
      referenceId:   ledgerCtx.referenceId,
      description:   ledgerCtx.description,
    });

    return { awarded: coins, newTotal, newLifetime };
  }

  // ═════════════════════════════════════════════════════════════
  // PRIVATE: DEBIT  (lifetime_coins is NOT decremented — it's "ever earned")
  // ═════════════════════════════════════════════════════════════
  private async debitCoins(
    qr: QueryRunner,
    userId: number,
    coins: number,
    ledgerCtx: {
      eventType: 'ADMIN_ADJUST' | 'REDEEMED' | 'EXPIRED';
      referenceType?: string;
      referenceId?: number;
      description?: string;
    },
  ): Promise<CoinsAwardResult> {
    const existing = await qr.query(
      `SELECT total_coins, lifetime_coins
       FROM user_coins WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!existing.length) {
      throw new BadRequestException('User has no coins to debit');
    }

    const totalBefore    = parseFloat(existing[0].total_coins);
    const lifetimeBefore = parseFloat(existing[0].lifetime_coins);

    if (totalBefore < coins) {
      throw new BadRequestException(
        `Insufficient coins. Available: ${totalBefore}, requested: ${coins}`,
      );
    }

    const newTotal = totalBefore - coins;

    await qr.query(
      `UPDATE user_coins
       SET total_coins = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [newTotal, userId],
    );

    await this.coinLedger.write({
      qr,
      userId,
      eventType:     ledgerCtx.eventType,
      coins,                                    // ledger.coins is unsigned; eventType conveys direction
      balanceBefore: totalBefore,
      balanceAfter:  newTotal,
      referenceType: ledgerCtx.referenceType,
      referenceId:   ledgerCtx.referenceId,
      description:   ledgerCtx.description,
    });

    return { awarded: -coins, newTotal, newLifetime: lifetimeBefore };
  }

  // ═════════════════════════════════════════════════════════════
  // QUERIES
  // ═════════════════════════════════════════════════════════════
  async getMyCoins(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT total_coins, lifetime_coins, updated_at
       FROM user_coins WHERE user_id = $1`,
      [userId],
    );
    if (!rows.length) {
      return { totalCoins: 0, lifetimeCoins: 0, updatedAt: null };
    }
    return {
      totalCoins:    parseFloat(rows[0].total_coins),
      lifetimeCoins: parseFloat(rows[0].lifetime_coins),
      updatedAt:     rows[0].updated_at,
    };
  }

  async getCoinHistory(userId: number, page = 1, limit = 20) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const offset = (Math.max(page, 1) - 1) * safeLimit;

    const rows = await this.dataSource.query(
      `SELECT id, event_type, coins, balance_before, balance_after,
              reference_type, reference_id, description, created_at
       FROM coin_ledger
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [userId, safeLimit, offset],
    );

    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM coin_ledger WHERE user_id = $1`,
      [userId],
    );

    return { data: rows, page, limit: safeLimit, total: count[0].total };
  }

  // ═════════════════════════════════════════════════════════════
  // SETTINGS
  // ═════════════════════════════════════════════════════════════
  async getSettings() {
    const rows = await this.dataSource.query(
      `SELECT * FROM coin_settings ORDER BY id DESC LIMIT 1`,
    );
    if (!rows.length) {
      throw new NotFoundException(
        'No coin settings configured. Run the seed migration first.',
      );
    }
    return rows[0];
  }

  async updateSettings(dto: UpdateCoinSettingsDto, adminId: number) {
    const current = await this.getSettings();

    const merged = {
      coins_per_unit:     dto.coinsPerUnit     ?? current.coins_per_unit,
      deposit_unit:       dto.depositUnit      ?? current.deposit_unit,
      min_deposit_amount: dto.minDepositAmount ?? current.min_deposit_amount,
      max_deposit_amount: dto.maxDepositAmount ?? current.max_deposit_amount,
      is_active:          dto.isActive         ?? current.is_active,
    };

    const result = await this.dataSource.query(
      `UPDATE coin_settings
       SET coins_per_unit = $1, deposit_unit = $2,
           min_deposit_amount = $3, max_deposit_amount = $4,
           is_active = $5, updated_by_admin_id = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        merged.coins_per_unit,
        merged.deposit_unit,
        merged.min_deposit_amount,
        merged.max_deposit_amount,
        merged.is_active,
        adminId,
        current.id,
      ],
    );
    return result[0];
  }
}
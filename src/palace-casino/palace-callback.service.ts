import { Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { WalletGateway } from 'src/wallet/wallet.gateway';  

/**
 * Handles wallet operations triggered by Palace callbacks.
 *
 * Palace expects responses in shape: { result, status, data }
 *   - result: 0 = OK, non-zero = error code
 *   - status: human-readable message
 *
 * IMPORTANT: We always return HTTP 200 with an error in `result` field.
 * Never throw HTTP errors at Palace — they'll retry indefinitely.
 *
 * Idempotency: every bet/win must be safe to call N times. We rely on
 * the UNIQUE constraint on slot_transactions.trans_guid + a duplicate-check
 * at the top of each handler.
 */
@Injectable()
export class PalaceCallbackService {
  private readonly logger = new Logger(PalaceCallbackService.name);

  constructor(private readonly dataSource: DataSource,
        private readonly walletGateway: WalletGateway,

  ) { }

  // ═══ AUTHENTICATE: Palace verifies the player exists ═══════════════════
  async authenticate(data: any, check: string) {
    const user = await this.findUserByAccount(data.account);
    const balance = await this.getBalance(user.id);
    return {
      result: 0,
      status: 'OK',
      data: { account: data.account, balance },
    };
  }

  // ═══ BALANCE: Palace asks for current balance ══════════════════════════
  async balance(data: any, check: string) {
    const user = await this.findUserByAccount(data.account);
    const balance = await this.getBalance(user.id);
    return { result: 0, status: 'OK', data: { balance } };
  }

  // ═══ BET: deduct from wallet ═══════════════════════════════════════════
  async bet(data: any, check: string) {
    return this.adjustWallet(data, 'bet', -1);
  }

  // ═══ WIN: credit to wallet ═════════════════════════════════════════════
  async win(data: any, check: string) {
    return this.adjustWallet(data, 'win', +1);
  }

  // ═══ CANCEL: refund a previous bet ═════════════════════════════════════
  async cancel(data: any, check: string) {
    const q = this.dataSource.createQueryRunner();
    try {
      await q.connect();
      await q.startTransaction();

      const user = await this.findUserByAccount(data.account, q);

      // 🔒 Idempotency on the cancel transaction itself
      const dup = await q.query(
        `SELECT balance_after FROM slot_transactions WHERE trans_guid = $1`,
        [data.trans_guid],
      );
      if (dup.length) {
        await q.commitTransaction();
        return {
          result: 0,
          status: 'OK',
          data: { balance: Number(dup[0].balance_after) },
        };
      }

      // Find the original transaction being cancelled
      const original = await q.query(
        `SELECT id, amount, is_cancelled FROM slot_transactions
         WHERE trans_guid = $1`,
        [data.cancel_trans_guid],
      );
      if (!original.length) {
        await q.rollbackTransaction();
        return { result: 42, status: 'Original transaction not found', data: {} };
      }
      if (original[0].is_cancelled) {
        const bal = await this.getBalance(user.id);
        await q.commitTransaction();
        return { result: 0, status: 'OK', data: { balance: bal } };
      }

      // Lock wallet row, refund
      const wallet = await q.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [user.id],
      );
      const newBalance = Number(wallet[0].balance) + Number(data.amount);

      await q.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
        newBalance,
        user.id,
      ]);

      await q.query(
        `UPDATE slot_transactions SET is_cancelled = true WHERE trans_guid = $1`,
        [data.cancel_trans_guid],
      );

      await q.query(
        `INSERT INTO slot_transactions
           (trans_guid, user_id, round_id, game_code, type, amount, balance_after)
         VALUES ($1, $2, $3, $4, 'cancel', $5, $6)`,
        [
          data.trans_guid,
          user.id,
          data.round_id,
          data.game_code,
          data.amount,
          newBalance,
        ],
      );

      await q.commitTransaction();
       // 📡 Push updated balance to user's WS connection
      await this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
        this.logger.warn(`WS push failed (cancel) userId=${user.id}: ${e.message}`),
      );
      return { result: 0, status: 'OK', data: { balance: newBalance } };
    } catch (err: any) {
      await q.rollbackTransaction();
      this.logger.error(`Cancel failed: ${err.message}`, err.stack);
      return {
        result: err.code ?? 1,
        status: err.message ?? 'Internal error',
        data: {},
      };
    } finally {
      await q.release();
    }
  }

  // ═══ STATUS: Palace checks if a transaction was processed ══════════════
  async status(data: any, check: string) {
    const tx = await this.dataSource.query(
      `SELECT balance_after FROM slot_transactions WHERE trans_guid = $1`,
      [data.trans_guid],
    );

    if (tx.length) {
      // Already processed — confirm it
      return {
        result: 0,
        status: 'OK',
        data: { balance: Number(tx[0].balance_after) },
      };
    }

    // Not processed yet — return current balance so Palace knows to retry
    const user = await this.findUserByAccount(data.account);
    const balance = await this.getBalance(user.id);
    return { result: 0, status: 'OK', data: { balance } };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════════════

  private async findUserByAccount(account: string, q?: QueryRunner) {
    this.logger.log(`Looking up username = "${account}"`);  // ← add

    const runner = q ?? this.dataSource;
    const rows = await runner.query(
      `SELECT id, account_status FROM users WHERE username = $1 LIMIT 1`,
      [account],
    );
    if (!rows.length) {
      this.logger.error(`✗ No user found: "${account}" — does this username exist in your users table?`);  // ← add

      throw { code: 21, message: 'User not found' };
    }
    if (rows[0].account_status !== 'ACTIVE') {
      this.logger.error(`✗ User "${account}" status = "${rows[0].account_status}"`);  // ← add
      throw { code: 22, message: `User not active: ${rows[0].account_status}` };
    }
    this.logger.log(`✓ Found user id=${rows[0].id}`);
    return rows[0];
  }

  private async getBalance(userId: number): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT balance FROM wallets WHERE user_id = $1`,
      [userId],
    );
    return Number(rows[0]?.balance ?? 0);
  }

  /**
   * Shared wallet adjustment for bet/win.
   * sign = -1 for bet (deduct), +1 for win (credit).
   */
  private async adjustWallet(
    data: any,
    type: 'bet' | 'win',
    sign: 1 | -1,
  ) {
    const q = this.dataSource.createQueryRunner();
    try {
        this.logger.log(`${type} → account="${data.account}" amount=${data.amount} trans_guid="${data.trans_guid}"`); 
      await q.connect();
      await q.startTransaction();

      const user = await this.findUserByAccount(data.account, q);

      // 🔒 Idempotency — Palace retries on timeout
      const dup = await q.query(
        `SELECT balance_after FROM slot_transactions WHERE trans_guid = $1`,
        [data.trans_guid],
      );
      if (dup.length) {
        await q.commitTransaction();
        return {
          result: 0,
          status: 'OK',
          data: { balance: Number(dup[0].balance_after) },
        };
      }

      // Lock wallet row
      const wallet = await q.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [user.id],
      );
      if (!wallet.length) {
        throw { code: 1, message: 'Wallet not found' };
      }

      const current = Number(wallet[0].balance);
      const delta = sign * Number(data.amount);
      const newBalance = current + delta;

      if (type === 'bet' && newBalance < 0) {
        throw { code: 31, message: 'Insufficient balance' };
      }

      await q.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
        newBalance,
        user.id,
      ]);

      await q.query(
        `INSERT INTO slot_transactions
           (trans_guid, user_id, round_id, game_code, type, amount, balance_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          data.trans_guid,
          user.id,
          data.round_id,
          data.game_code,
          type,
          data.amount,
          newBalance,
        ],
      );

      await q.commitTransaction();
        // 📡 Push updated balance to user's WS — fire-and-forget, never break Palace response
      await this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
        this.logger.warn(`WS push failed (${type}) userId=${user.id}: ${e.message}`),
      );
      return { result: 0, status: 'OK', data: { balance: newBalance } };
    } catch (err: any) {
      await q.rollbackTransaction();
      this.logger.error(`${type} failed: ${err.message}`, err.stack);
      return {
        result: err.code ?? 1,
        status: err.message ?? 'Internal error',
        data: {},
      };
    } finally {
      await q.release();
    }
  }
}

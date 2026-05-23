import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  BalanceRequestDto,
  TransactionRequestDto,
  BatchTransactionsRequestDto,
  OroplayCallbackResponse,
  OROPLAY_ERROR,
} from './dto/callback.dto';

/**
 * Handles OroPlay's seamless wallet callbacks.
 *
 * Convention: we use the player's `username` as their OroPlay userCode.
 * All transactions are idempotent via `transaction_code` unique constraint.
 */
@Injectable()
export class OroplayCallbackService {
  private readonly logger = new Logger(OroplayCallbackService.name);

  constructor(private readonly dataSource: DataSource) {}

  // ─── Balance ─────────────────────────────────────────────────
  async getBalance(dto: BalanceRequestDto): Promise<OroplayCallbackResponse> {
    if (!dto?.userCode) {
      return { success: false, message: 'Missing userCode', errorCode: OROPLAY_ERROR.BAD_REQUEST };
    }

    const rows = await this.dataSource.query(
      `SELECT w.balance
         FROM wallets w
         JOIN users u ON u.id = w.user_id
        WHERE u.username = $1
        LIMIT 1`,
      [dto.userCode],
    );

    if (!rows.length) {
      return {
        success: false,
        message: 'User not found',
        errorCode: OROPLAY_ERROR.USER_DOES_NOT_EXIST,
      };
    }

    return {
      success: true,
      message: parseFloat(rows[0].balance),
      errorCode: OROPLAY_ERROR.NO_ERROR,
    };
  }

  // ─── Single Transaction ──────────────────────────────────────
  async handleTransaction(dto: TransactionRequestDto): Promise<OroplayCallbackResponse> {
    const {
      userCode, vendorCode, gameCode, historyId, roundId, gameType,
      transactionCode, isFinished, isCanceled, amount, detail, createdAt,
    } = dto;

    if (!userCode || !transactionCode) {
      return {
        success: false,
        message: 'Missing userCode or transactionCode',
        errorCode: OROPLAY_ERROR.BAD_REQUEST,
      };
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // 1️⃣ Idempotency check — has this transactionCode already been processed?
      const existing = await qr.query(
        `SELECT balance_after FROM oroplay_transactions WHERE transaction_code = $1 LIMIT 1`,
        [transactionCode],
      );
      if (existing.length) {
        await qr.rollbackTransaction();
        this.logger.warn(`Duplicate transactionCode rejected: ${transactionCode}`);
        return {
          success: false,
          message: 'Duplicate transaction',
          errorCode: OROPLAY_ERROR.DUPLICATE_TRANSACTION,
        };
      }

      // 2️⃣ Optional: check round status — if a "finished" tx was already recorded
      //    for this round, any further activity is INVALID_TRANSACTION.
      if (roundId) {
        const finishedRows = await qr.query(
          `SELECT 1 FROM oroplay_transactions
            WHERE round_id = $1 AND is_finished = TRUE
            LIMIT 1`,
          [roundId],
        );
        if (finishedRows.length) {
          await qr.rollbackTransaction();
          return {
            success: false,
            message: 'Round already finished',
            errorCode: OROPLAY_ERROR.INVALID_TRANSACTION,
          };
        }
      }

      // 3️⃣ Lock wallet row, fetch balance
      const userRows = await qr.query(
        `SELECT u.id AS user_id, w.balance
           FROM users u
           JOIN wallets w ON w.user_id = u.id
          WHERE u.username = $1
          FOR UPDATE OF w`,
        [userCode],
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        return {
          success: false,
          message: 'User not found',
          errorCode: OROPLAY_ERROR.USER_DOES_NOT_EXIST,
        };
      }
      const userId = userRows[0].user_id;
      const currentBalance = parseFloat(userRows[0].balance);

      // 4️⃣ Compute new balance
      const txAmount = parseFloat(String(amount));
      const newBalance = currentBalance + txAmount;

      // 5️⃣ Insufficient funds check (only bets, where amount < 0)
      if (newBalance < 0) {
        await qr.rollbackTransaction();
        this.logger.warn(
          `Insufficient balance for ${userCode}: have ${currentBalance}, need ${-txAmount}`,
        );
        return {
          success: false,
          message: 'Insufficient balance',
          errorCode: OROPLAY_ERROR.INSUFFICIENT_USER_BALANCE,
        };
      }

      // 6️⃣ Update wallet
      await qr.query(
        `UPDATE wallets SET balance = $1 WHERE user_id = $2`,
        [newBalance, userId],
      );

      // 7️⃣ Record transaction — UNIQUE on transaction_code protects against races
      await qr.query(
        `INSERT INTO oroplay_transactions
           (transaction_code, history_id, round_id, user_id, vendor_code, game_code,
            game_type, amount, is_finished, is_canceled, balance_after, detail,
            created_at_provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          transactionCode, historyId, roundId, userId, vendorCode, gameCode,
          gameType, txAmount, isFinished, isCanceled, newBalance, detail,
          createdAt ? new Date(createdAt) : null,
        ],
      );

      await qr.commitTransaction();

      this.logger.log(
        `Tx OK: ${transactionCode} user=${userCode} amount=${txAmount} balance=${newBalance}`,
      );

      return {
        success: true,
        message: newBalance,
        errorCode: OROPLAY_ERROR.NO_ERROR,
      };
    } catch (err: any) {
      await qr.rollbackTransaction();

      // Handle race-condition duplicate insert
      if (err.code === '23505' /* PG unique_violation */) {
        return {
          success: false,
          message: 'Duplicate transaction',
          errorCode: OROPLAY_ERROR.DUPLICATE_TRANSACTION,
        };
      }

      this.logger.error(`Transaction handler failed: ${err.message}`, err.stack);
      throw err;
    } finally {
      await qr.release();
    }
  }

  // ─── Batch Transactions ──────────────────────────────────────
  /**
   * OroPlay sometimes sends multiple transactions in one call (e.g. fishing games).
   * We process them sequentially — if any fails, we still report the error and stop.
   * The final balance is whatever the last successful tx left in the wallet.
   */
  async handleBatchTransactions(
    dto: BatchTransactionsRequestDto,
  ): Promise<OroplayCallbackResponse> {
    if (!dto?.transactions?.length) {
      return {
        success: false,
        message: 'No transactions in batch',
        errorCode: OROPLAY_ERROR.BAD_REQUEST,
      };
    }

    let finalBalance = 0;
    for (const tx of dto.transactions) {
      const result = await this.handleTransaction(tx);
      if (!result.success) {
        // Stop on first failure
        return result;
      }
      finalBalance = result.message as number;
    }

    return {
      success: true,
      message: finalBalance,
      errorCode: OROPLAY_ERROR.NO_ERROR,
    };
  }
}

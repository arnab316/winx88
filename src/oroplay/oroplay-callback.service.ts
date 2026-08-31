import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  BalanceRequestDto,
  TransactionRequestDto,
  BatchTransactionsRequestDto,
  OroplayCallbackResponse,
  OROPLAY_ERROR,
} from './dto/callback.dto';
import { TurnoverService } from 'src/turnover/turnover.service';

/**
 * Handles OroPlay's seamless wallet callbacks.
 *
 * Convention: we use the player's `username` as their OroPlay userCode.
 * All transactions are idempotent via `transaction_code` unique constraint.
 */
@Injectable()
export class OroplayCallbackService {
  private readonly logger = new Logger(OroplayCallbackService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly turnoverService: TurnoverService,
  ) {}

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
        `SELECT u.id AS user_id, u.account_status, w.balance
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

      // 4️⃣.5 Account must still be ACTIVE to STAKE. The launch guard only
      // blocks new launches; a session already open on OroPlay's side keeps
      // sending bets after an admin suspends the player, so the stake leg is
      // refused here too. Wins/refunds (amount >= 0) still settle, so a round
      // staked before the suspension is not swallowed.
      const accountStatus = userRows[0].account_status;
      if (accountStatus !== 'ACTIVE' && txAmount < 0) {
        await qr.rollbackTransaction();
        this.logger.warn(
          `Rejected stake for ${userCode}: account is ${accountStatus} (tx ${transactionCode})`,
        );
        return {
          success: false,
          message: `Account is ${accountStatus}`,
          errorCode: OROPLAY_ERROR.INVALID_TRANSACTION,
        };
      }

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
      const inserted = await qr.query(
        `INSERT INTO oroplay_transactions
           (transaction_code, history_id, round_id, user_id, vendor_code, game_code,
            game_type, amount, is_finished, is_canceled, balance_after, detail,
            created_at_provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          transactionCode, historyId, roundId, userId, vendorCode, gameCode,
          gameType, txAmount, isFinished, isCanceled, newBalance, detail,
          createdAt ? new Date(createdAt) : null,
        ],
      );
      const txRowId = Number(inserted[0].id);

      // 8️⃣ Turnover (mirrors in-house settlement + Palace). Signed-amount model:
      //   • BET (amount < 0, not cancelled) → stake counts toward turnover.
      //   • WIN (amount > 0)                → contributes nothing (payouts never count).
      //   • Bet refund (cancelled + amount > 0) → reverse the stake it had added.
      //   All inside this same transaction, so it's atomic with the wallet move
      //   and skips silently when the user has no active requirement.
      if (!isCanceled && txAmount < 0) {
        await this.turnoverService.contributeFromSettledBet(
          qr, userId, txRowId, Math.abs(txAmount),
        );
      } else if (isCanceled && txAmount > 0 && roundId) {
        // OroPlay cancels carry no pointer to the original bet, so match it by
        // round + opposite amount (the not-yet-cancelled bet). Flag it cancelled
        // to prevent a second refund reversing the same bet, then undo exactly
        // the turnover that bet contributed.
        const orig = await qr.query(
          `SELECT id FROM oroplay_transactions
            WHERE user_id = $1 AND round_id = $2
              AND amount = $3 AND is_canceled = FALSE
              AND id <> $4
            ORDER BY id DESC
            LIMIT 1`,
          [userId, roundId, -txAmount, txRowId],
        );
        if (orig.length) {
          await qr.query(
            `UPDATE oroplay_transactions SET is_canceled = TRUE WHERE id = $1`,
            [orig[0].id],
          );
          await this.turnoverService.reverseContribution(
            qr, userId, Number(orig[0].id), txRowId,
          );
        }
      }

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

// src/game/game-validation.service.ts
import {
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * Single Responsibility: answer "what is this user's bet state?"
 *
 * Used by wallet during withdrawal flow to enforce the rule:
 *   "Cannot withdraw while any bet is unsettled."
 *
 * Why a separate service from GameService?
 *   - Avoids circular dep: wallet → game → wallet (via FinancialLedger)
 *   - GameService is heavy (placeBet, settleRound, etc); we only need queries
 *   - Single Responsibility — this service never mutates state
 */
@Injectable()
export class GameValidationService {
  constructor(private dataSource: DataSource) {}

  /**
   * Throws ForbiddenException if the user has any bet still
   * in PENDING / OPEN state (round not yet settled).
   *
   * Pass the caller's QueryRunner if inside a transaction
   * (so the read is consistent with the rest of the txn).
   */
  async ensureNoPendingBets(
    qrOrNull: QueryRunner | null,
    userId: number,
  ): Promise<void> {
    const runner = qrOrNull ?? this.dataSource;

    const rows = await runner.query(
      `SELECT b.id, b.bet_code, b.bet_amount, b.bet_number,
              b.created_at,
              gr.round_code, gr.status AS round_status,
              g.name AS game_name
       FROM bets b
       JOIN game_rounds gr ON gr.id = b.round_id
       JOIN games g       ON g.id = b.game_id
       WHERE b.user_id = $1
         AND b.result_status IN ('PENDING', 'OPEN')
       ORDER BY b.created_at ASC
       LIMIT 5`,
      [userId],
    );

    if (rows.length === 0) return;

    // Build a useful error so the user knows WHICH bets are pending
    throw new ForbiddenException({
      message: 'Withdrawal blocked: you have unsettled bets',
      hint: 'Wait for the round result to be published before withdrawing.',
      pendingBetsCount: rows.length,
      pendingBets: rows.map((r: any) => ({
        betCode:   r.bet_code,
        gameName:  r.game_name,
        roundCode: r.round_code,
        amount:    parseFloat(r.bet_amount),
        betNumber: r.bet_number,
        placedAt:  r.created_at,
      })),
    });
  }

  /**
   * Lightweight version for UI hints — returns count, doesn't throw.
   */
  async getPendingBetsCount(userId: number): Promise<number> {
    const result = await this.dataSource.query(
      `SELECT COUNT(*)::int AS c
       FROM bets
       WHERE user_id = $1
         AND result_status IN ('PENDING','OPEN')`,
      [userId],
    );
    return result[0].c;
  }
}
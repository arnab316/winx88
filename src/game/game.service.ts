import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class GameService {
  constructor(private readonly dataSource: DataSource) {}



   // 🟢 CREATE GAME
  async createGame(payload: any) {
    const { code, name, digit_length, min_bet, max_bet, payout_multiplier } = payload;

    const game = await this.dataSource.query(
      `INSERT INTO games 
      (code, name, digit_length, min_bet, max_bet, payout_multiplier)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
      [code, name, digit_length, min_bet, max_bet, payout_multiplier],
    );

    return game[0];
  }

  // 🟢 CREATE ROUND
  async createRound(payload: any) {
    const { game_id, round_code, open_time, close_time, draw_time } = payload;

    return await this.dataSource.query(
      `INSERT INTO game_rounds 
      (game_id, round_code, open_time, close_time, draw_time)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *`,
      [game_id, round_code, open_time, close_time, draw_time],
    );
  }

  // 🟡 ADD HOT NUMBER (ADMIN FEATURE)
  async addHotNumber(payload: any) {
    const { game_id, number } = payload;

    return await this.dataSource.query(
      `INSERT INTO game_hot_numbers (game_id, number)
       VALUES ($1,$2)
       RETURNING *`,
      [game_id, number],
    );
  }

  // 🔴 PUBLISH RESULT (SEPARATE STEP)
  async publishResult(round_id: number, result_number: string) {
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Get round
      const round = await queryRunner.query(
        `SELECT * FROM game_rounds WHERE id = $1`,
        [round_id],
      );

      if (!round.length) throw new BadRequestException('Round not found');

      // 2. Insert result
      await queryRunner.query(
        `INSERT INTO game_results (game_id, round_id, result_number)
         VALUES ($1,$2,$3)`,
        [round[0].game_id, round_id, result_number],
      );

      // 3. Update round status
      await queryRunner.query(
        `UPDATE game_rounds 
         SET status = 'RESULT_PUBLISHED'
         WHERE id = $1`,
        [round_id],
      );

      await queryRunner.commitTransaction();

      return { message: 'Result published' };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  } 

  // 🟢 PLACE BET
  async placeBet(payload: any) {
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const { user_id, game_id, round_id, bet_number, amount } = payload;

      // 🔒 1. Lock wallet
      const wallet = await queryRunner.query(
        `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [user_id],
      );

      if (!wallet.length) throw new BadRequestException('Wallet not found');

      if (Number(wallet[0].available_balance) < amount) {
        throw new BadRequestException('Insufficient balance');
      }

      // 🧠 2. Get game config
      const game = await queryRunner.query(
        `SELECT * FROM games WHERE id = $1 AND is_active = true`,
        [game_id],
      );

      if (!game.length) throw new BadRequestException('Invalid game');

      const multiplier = Number(game[0].payout_multiplier);

      // 🎯 3. Validate digit length
      if (bet_number.length !== Number(game[0].digit_length)) {
        throw new BadRequestException('Invalid bet number length');
      }

      // 💰 4. Deduct wallet
      await queryRunner.query(
        `UPDATE wallets 
         SET available_balance = available_balance - $1,
             total_bet = total_bet + $1
         WHERE user_id = $2`,
        [amount, user_id],
      );

      // 🧾 5. Insert bet
      const betCode = `BET-${Date.now()}`;

      const potentialPayout = amount * multiplier;

      const bet = await queryRunner.query(
        `INSERT INTO bets 
        (bet_code, user_id, game_id, round_id, bet_number, bet_amount, payout_multiplier, potential_payout)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [
          betCode,
          user_id,
          game_id,
          round_id,
          bet_number,
          amount,
          multiplier,
          potentialPayout,
        ],
      );

      // 📊 6. Update exposure
      await queryRunner.query(
        `INSERT INTO game_number_stats (game_id, round_id, bet_number, total_amount, total_bets)
         VALUES ($1,$2,$3,$4,1)
         ON CONFLICT (game_id, round_id, bet_number)
         DO UPDATE SET
           total_amount = game_number_stats.total_amount + $4,
           total_bets = game_number_stats.total_bets + 1`,
        [game_id, round_id, bet_number, amount],
      );

      // 🧾 7. Ledger entry
      await queryRunner.query(
        `INSERT INTO financial_ledger 
        (ledger_code, user_id, wallet_id, entry_type, flow, amount,
         balance_before, balance_after,
         reference_type, reference_id)
        VALUES ($1,$2,$3,'BET_PLACED','DEBIT',$4,$5,$6,'BET',$7)`,
        [
          `LEDGER-${Date.now()}`,
          user_id,
          wallet[0].id,
          amount,
          wallet[0].available_balance,
          wallet[0].available_balance - amount,
          bet[0].id,
        ],
      );

      await queryRunner.commitTransaction();
      return bet[0];
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  // 🔵 SETTLE ROUND
  async settleRound(round_id: number, result_number: string) {
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 🧾 1. Save result
      await queryRunner.query(
        `INSERT INTO game_results (round_id, result_number)
         VALUES ($1,$2)`,
        [round_id, result_number],
      );

      // 📦 2. Get all bets
      const bets = await queryRunner.query(
        `SELECT * FROM bets WHERE round_id = $1`,
        [round_id],
      );

      for (const bet of bets) {
        if (bet.bet_number === result_number) {
          const payout = Number(bet.potential_payout);

          // 💳 Wallet update
          await queryRunner.query(
            `UPDATE wallets 
             SET available_balance = available_balance + $1,
                 total_win = total_win + $1
             WHERE user_id = $2`,
            [payout, bet.user_id],
          );

          // 🧾 Ledger
          await queryRunner.query(
            `INSERT INTO financial_ledger 
            (ledger_code, user_id, wallet_id, entry_type, flow, amount,
             balance_before, balance_after,
             reference_type, reference_id)
            VALUES ($1,$2,$3,'WIN_CREDIT','CREDIT',$4,0,0,'BET_SETTLEMENT',$5)`,
            [
              `LEDGER-${Date.now()}`,
              bet.user_id,
              0, // (you can fetch wallet_id if needed)
              payout,
              bet.id,
            ],
          );

          // ✅ Update bet
          await queryRunner.query(
            `UPDATE bets 
             SET result_status = 'WON', settled_at = NOW()
             WHERE id = $1`,
            [bet.id],
          );
        } else {
          // ❌ LOST
          await queryRunner.query(
            `UPDATE bets 
             SET result_status = 'LOST', settled_at = NOW()
             WHERE id = $1`,
            [bet.id],
          );
        }
      }

      // 🟢 Update round
      await queryRunner.query(
        `UPDATE game_rounds SET status = 'SETTLED' WHERE id = $1`,
        [round_id],
      );

      await queryRunner.commitTransaction();

      return { message: 'Round settled successfully' };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
// src/game/game.service.ts
// FULL replacement.
//
// Key change vs previous Sub-pass 3:
//   - placeBet() NO LONGER calls turnover (removed)
//   - settleRound() now calls turnoverService.contributeFromSettledBet()
//     for EVERY bet (won OR lost) — bet amount counts either way.

import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import { TurnoverService } from '../turnover/turnover.service';

@Injectable()
export class GameService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly financialLedger: FinancialLedgerService,
    private readonly turnoverService: TurnoverService,
  ) {}

  // 🟢 CREATE GAME
  async createGame(payload: any) {
    const { code, name, digit_length, min_bet, max_bet, payout_multiplier } = payload;
    const game = await this.dataSource.query(
      `INSERT INTO games (code, name, digit_length, min_bet, max_bet, payout_multiplier)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [code, name, digit_length, min_bet, max_bet, payout_multiplier],
    );
    return game[0];
  }

  // 🟢 CREATE ROUND
  async createRound(payload: any) {
    const { game_id, round_code, open_time, close_time, draw_time } = payload;
    return this.dataSource.query(
      `INSERT INTO game_rounds (game_id, round_code, open_time, close_time, draw_time)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [game_id, round_code, open_time, close_time, draw_time],
    );
  }

  // 🟡 ADD HOT NUMBER
  async addHotNumber(payload: any) {
    const { game_id, number } = payload;
    return this.dataSource.query(
      `INSERT INTO game_hot_numbers (game_id, number) VALUES ($1,$2) RETURNING *`,
      [game_id, number],
    );
  }

  // 🔴 PUBLISH RESULT (lightweight — full settlement logic in settleRound)
  async publishResult(round_id: number, result_number: string) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const round = await qr.query(
        `SELECT * FROM game_rounds WHERE id = $1`,
        [round_id],
      );
      if (!round.length) throw new BadRequestException('Round not found');

      await qr.query(
        `INSERT INTO game_results (game_id, round_id, result_number)
         VALUES ($1,$2,$3)`,
        [round[0].game_id, round_id, result_number],
      );
      await qr.query(
        `UPDATE game_rounds SET status = 'RESULT_PUBLISHED' WHERE id = $1`,
        [round_id],
      );
      await qr.commitTransaction();
      return { message: 'Result published' };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // 🟢 PLACE BET
  //   NOTE: turnover is NOT updated here. It only updates on settle.
  async placeBet(payload: any) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const { user_id, game_id, round_id, bet_number, amount } = payload;

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new BadRequestException('amount must be a positive number');
      }

      // 🔒 1. Lock wallet
      const walletRows = await qr.query(
        `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [user_id],
      );
      if (!walletRows.length) throw new BadRequestException('Wallet not found');
      const wallet = walletRows[0];

      const balBefore = parseFloat(wallet.balance);
      const bonBefore = parseFloat(wallet.bonus_balance);
      const lckBefore = parseFloat(wallet.locked_balance);

      if (balBefore < amount) {
        throw new BadRequestException('Insufficient balance');
      }

      // 🧠 2. Game config + validation
      const games = await qr.query(
        `SELECT * FROM games WHERE id = $1 AND is_active = true`,
        [game_id],
      );
      if (!games.length) throw new BadRequestException('Invalid game');

      const game = games[0];
      const multiplier = parseFloat(game.payout_multiplier);
      const minBet = parseFloat(game.min_bet ?? '0');
      const maxBet = parseFloat(game.max_bet ?? '0');

      if (minBet && amount < minBet) {
        throw new BadRequestException(`Minimum bet is ${minBet}`);
      }
      if (maxBet && amount > maxBet) {
        throw new BadRequestException(`Maximum bet is ${maxBet}`);
      }
      if (String(bet_number).length !== Number(game.digit_length)) {
        throw new BadRequestException('Invalid bet number length');
      }

      // 🟡 3. Round must be open
      const rounds = await qr.query(
        `SELECT id, status, close_time FROM game_rounds WHERE id = $1`,
        [round_id],
      );
      if (!rounds.length) throw new BadRequestException('Round not found');
      if (rounds[0].status !== 'OPEN' && rounds[0].status !== 'PENDING') {
        throw new BadRequestException(`Round is ${rounds[0].status}, cannot bet`);
      }
      if (rounds[0].close_time && new Date(rounds[0].close_time) < new Date()) {
        throw new BadRequestException('Round closed for betting');
      }

      // 💰 4. Debit wallet
      const balAfter = balBefore - amount;
      await qr.query(
        `UPDATE wallets
         SET balance = $1, total_bet = total_bet + $2, updated_at = NOW()
         WHERE id = $3`,
        [balAfter, amount, wallet.id],
      );

      // 🧾 5. Insert bet (PENDING — will become WON/LOST in settleRound)
      const betCode = `BET-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const potentialPayout = amount * multiplier;

      const betRows = await qr.query(
        `INSERT INTO bets
          (bet_code, user_id, game_id, round_id, bet_number,
           bet_amount, payout_multiplier, potential_payout, result_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')
         RETURNING *`,
        [betCode, user_id, game_id, round_id, bet_number,
         amount, multiplier, potentialPayout],
      );
      const bet = betRows[0];

      // 📊 6. Exposure stats
      await qr.query(
        `INSERT INTO game_number_stats
          (game_id, round_id, bet_number, total_amount, total_bets)
         VALUES ($1,$2,$3,$4,1)
         ON CONFLICT (game_id, round_id, bet_number)
         DO UPDATE SET
           total_amount = game_number_stats.total_amount + $4,
           total_bets   = game_number_stats.total_bets + 1`,
        [game_id, round_id, bet_number, amount],
      );

      // 🧾 7. Financial ledger
      await this.financialLedger.write({
        qr,
        walletId:      wallet.id,
        userId:        user_id,
        entryType:     'BET_PLACED',
        flow:          'DEBIT',
        amount,
        balanceBefore: balBefore,
        balanceAfter:  balAfter,
        bonusBefore:   bonBefore,
        bonusAfter:    bonBefore,
        lockedBefore:  lckBefore,
        lockedAfter:   lckBefore,
        referenceType: 'BET',
        referenceId:   bet.id,
        status:        'SUCCESS',
        description:   `Bet placed on ${bet_number}`,
        createdByType: 'USER',
        createdById:   user_id,
      });

      // ⚠️ NO TURNOVER CONTRIBUTION HERE — moved to settleRound per business rule

      await qr.commitTransaction();
      return bet;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // 🔵 SETTLE ROUND
  //   This is where turnover progresses now.
  //   Every settled bet (won or lost) contributes its amount to turnover.
  async settleRound(round_id: number, result_number: string) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // Save result if not already saved
      const existing = await qr.query(
        `SELECT id FROM game_results WHERE round_id = $1`,
        [round_id],
      );
      if (!existing.length) {
        const round = await qr.query(
          `SELECT game_id FROM game_rounds WHERE id = $1`,
          [round_id],
        );
        if (!round.length) throw new BadRequestException('Round not found');

        await qr.query(
          `INSERT INTO game_results (game_id, round_id, result_number)
           VALUES ($1,$2,$3)`,
          [round[0].game_id, round_id, result_number],
        );
      }

      // Get all unsettled bets for this round
      const bets = await qr.query(
        `SELECT * FROM bets
         WHERE round_id = $1
           AND result_status IN ('PENDING','OPEN')`,
        [round_id],
      );

      let winners = 0;
      let losers = 0;

      for (const bet of bets) {
        const isWin = String(bet.bet_number) === String(result_number);
        const betAmount = parseFloat(bet.bet_amount);

        if (isWin) {
          winners++;
          const payout = parseFloat(bet.potential_payout);

          const winnerRows = await qr.query(
            `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
            [bet.user_id],
          );
          if (!winnerRows.length) continue;
          const w = winnerRows[0];
          const balBefore = parseFloat(w.balance);
          const balAfter  = balBefore + payout;

          await qr.query(
            `UPDATE wallets
             SET balance = $1, total_win = total_win + $2, updated_at = NOW()
             WHERE id = $3`,
            [balAfter, payout, w.id],
          );

          await this.financialLedger.write({
            qr,
            walletId:      w.id,
            userId:        bet.user_id,
            entryType:     'WIN_CREDIT',
            flow:          'CREDIT',
            amount:        payout,
            balanceBefore: balBefore,
            balanceAfter:  balAfter,
            bonusBefore:   parseFloat(w.bonus_balance),
            bonusAfter:    parseFloat(w.bonus_balance),
            lockedBefore:  parseFloat(w.locked_balance),
            lockedAfter:   parseFloat(w.locked_balance),
            referenceType: 'BET_SETTLEMENT',
            referenceId:   bet.id,
            status:        'SUCCESS',
            description:   `Won ${payout} on bet ${bet.bet_code}`,
            createdByType: 'SYSTEM',
          });

          await qr.query(
            `UPDATE bets
             SET result_status = 'WON', settled_at = NOW()
             WHERE id = $1`,
            [bet.id],
          );
        } else {
          losers++;
          await qr.query(
            `UPDATE bets
             SET result_status = 'LOST', settled_at = NOW()
             WHERE id = $1`,
            [bet.id],
          );
        }

        // 🎯 TURNOVER CONTRIBUTION (Sub-pass 3 revised)
        //   Per business rule: bet amount counts whether won or lost.
        //   Skips silently if user has no active turnover reqs.
        await this.turnoverService.contributeFromSettledBet(
          qr,
          bet.user_id,
          bet.id,
          betAmount,
        );
      }

      await qr.query(
        `UPDATE game_rounds SET status = 'SETTLED' WHERE id = $1`,
        [round_id],
      );

      await qr.commitTransaction();
      return {
        message: 'Round settled successfully',
        betsSettled: bets.length,
        winners,
        losers,
      };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
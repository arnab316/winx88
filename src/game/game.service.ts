// src/game/game.service.ts
//
// Full file. Contains:
//   ORIGINAL: createGame, createRound, addHotNumber, publishResult,
//             placeBet (with G1 max-payout check), settleRound
//   G1 LISTINGS: listGames, listHotGames, listJackpotGames,
//                listGamesByDigitLength, getGameById,
//                listHotNumbersForGame
//   G1 ROUNDS:  listRoundsForGame, getActiveRoundsForGame
//   G1 RESULTS: getRecentResultsForGame, getRoundResult
//   G1 ADMIN:   updateGameFlags, adminListHotNumbers, createHotNumber,
//               updateHotNumber, deleteHotNumber, toggleHotNumber,
//               reorderHotNumbers

import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import { TurnoverService } from '../turnover/turnover.service';
import { GamesGateway } from './games.gateway';

import {
  UpdateGameFlagsDto,
  CreateHotNumberDto,
  UpdateHotNumberDto,
  ReorderHotNumbersDto,
  ListGamesQueryDto,
  ListRoundsQueryDto,
  DigitLength,
  RoundStatus,
} from './dto/game.dto';

@Injectable()
export class GameService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly financialLedger: FinancialLedgerService,
    private readonly turnoverService: TurnoverService,
      private readonly gateway: GamesGateway,   

  ) {}

  // ═════════════════════════════════════════════════════════════
  // ORIGINAL: CREATE GAME
  // ═════════════════════════════════════════════════════════════
  async createGame(payload: any) {
    const { code, name, digit_length, min_bet, max_bet, payout_multiplier } = payload;
    const game = await this.dataSource.query(
      `INSERT INTO games (code, name, digit_length, min_bet, max_bet, payout_multiplier)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [code, name, digit_length, min_bet, max_bet, payout_multiplier],
    );
    return game[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ORIGINAL: CREATE ROUND
  // ═════════════════════════════════════════════════════════════
  async createRound(payload: any) {
    const { game_id, round_code, open_time, close_time, draw_time } = payload;
    const rows = await this.dataSource.query(
      `INSERT INTO game_rounds (game_id, round_code, open_time, close_time, draw_time)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [game_id, round_code, open_time, close_time, draw_time],
    );
 
    const round = rows[0];
    if (round) {
      // Fire WebSocket event so subscribers see the new round instantly
      this.gateway.emitRoundOpened({
        gameId:    Number(round.game_id),
        roundId:   Number(round.id),
        roundCode: round.round_code,
        openTime:  round.open_time,
        closeTime: round.close_time,
        drawTime:  round.draw_time,
      });
    }
    return rows;        // preserves your current return shape (array)
  }

  // ═════════════════════════════════════════════════════════════
  // ORIGINAL: ADD HOT NUMBER (legacy; prefer createHotNumber)
  // ═════════════════════════════════════════════════════════════
  async addHotNumber(payload: any) {
    const { game_id, number } = payload;
    return this.dataSource.query(
      `INSERT INTO game_hot_numbers (game_id, number) VALUES ($1,$2) RETURNING *`,
      [game_id, number],
    );
  }

  // ═════════════════════════════════════════════════════════════
  // ORIGINAL: PUBLISH RESULT
  // ═════════════════════════════════════════════════════════════
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
      const gameIdForEmit = Number(round[0].game_id);
      await qr.commitTransaction();
       // Fire AFTER commit — only emit if DB write actually succeeded.
      this.gateway.emitResultPublished({
        gameId: gameIdForEmit,
        roundId: round_id,
        resultNumber: result_number,
      });
      return { message: 'Result published' };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ORIGINAL: PLACE BET (with G1 max-payout exposure check)
  // ═════════════════════════════════════════════════════════════
  async placeBet(payload: any) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const { user_id, game_id, round_id, bet_number, amount } = payload;

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new BadRequestException('amount must be a positive number');
      }

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

      // 🛡️ G1: Max-payout exposure check
      if (game.max_payout_per_round) {
        const cap = parseFloat(game.max_payout_per_round);

        const exposureRows = await qr.query(
          `SELECT COALESCE(SUM(potential_payout), 0)::numeric AS exposure
           FROM bets
           WHERE round_id = $1 AND result_status IN ('PENDING','OPEN')`,
          [round_id],
        );
        const currentExposure = parseFloat(exposureRows[0].exposure);
        const thisBetPayout   = amount * multiplier;
        const projectedTotal  = currentExposure + thisBetPayout;

        if (projectedTotal > cap) {
          const remaining = Math.max(0, cap - currentExposure);
          const maxBetAllowed = remaining > 0
            ? Math.floor((remaining / multiplier) * 100) / 100
            : 0;

          throw new BadRequestException({
            message: 'Round payout cap reached. Try a smaller bet or wait for next round.',
            cap,
            currentExposure,
            requestedPayout: thisBetPayout,
            maxBetAllowedNow: maxBetAllowed,
          });
        }
      }

      const balAfter = balBefore - amount;
      await qr.query(
        `UPDATE wallets
         SET balance = $1, total_bet = total_bet + $2, updated_at = NOW()
         WHERE id = $3`,
        [balAfter, amount, wallet.id],
      );

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

      await qr.commitTransaction();
      return bet;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ORIGINAL: SETTLE ROUND
  // ═════════════════════════════════════════════════════════════
  async settleRound(round_id: number, result_number: string) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
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
       const r = await this.dataSource.query(
        `SELECT game_id FROM game_rounds WHERE id = $1`,
        [round_id],
      );
      if (r.length) {
        this.gateway.emitRoundSettled({
          gameId: Number(r[0].game_id),
          roundId: round_id,
          betsSettled: bets.length,
          winners,
          losers,
        });
      }
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

  // ╔═══════════════════════════════════════════════════════════╗
  // ║              GAME LISTING ENDPOINTS (public)              ║
  // ╚═══════════════════════════════════════════════════════════╝

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: LIST GAMES (filterable — main listing endpoint)
  //   Filters: isActive, isHot, isJackpotBadge, category, digitLength
  // ═════════════════════════════════════════════════════════════
  async listGames(q: ListGamesQueryDto) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    // Default to active-only for public consumption
    if (q.isActive !== undefined) {
      where.push(`is_active = $${i++}`);
      params.push(q.isActive);
    } else {
      where.push(`is_active = TRUE`);
    }
    if (q.isHot !== undefined) {
      where.push(`is_hot = $${i++}`);
      params.push(q.isHot);
    }
    if (q.isJackpotBadge !== undefined) {
      where.push(`is_jackpot_badge = $${i++}`);
      params.push(q.isJackpotBadge);
    }
    if (q.category) {
      where.push(`display_category = $${i++}`);
      params.push(q.category);
    }
    if (q.digitLength) {
      where.push(`digit_length = $${i++}`);
      params.push(q.digitLength);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    return this.dataSource.query(
      `SELECT id, code, name, description, thumbnail_url,
              digit_length, min_bet, max_bet, payout_multiplier,
              max_payout_per_round, result_mode,
              is_hot, hot_priority, is_jackpot_badge,
              display_category, is_active, created_at, updated_at
       FROM games
       ${whereSql}
       ORDER BY
         is_hot DESC,
         hot_priority DESC,
         display_category ASC,
         id ASC`,
      params,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: GET ONE GAME (detail page)
  //   Returns the game + a small summary block (active rounds count,
  //   active hot numbers count) so the detail page is one fetch.
  // ═════════════════════════════════════════════════════════════
  async getGameById(gameId: number) {
    const games = await this.dataSource.query(
      `SELECT id, code, name, description, thumbnail_url,
              digit_length, min_bet, max_bet, payout_multiplier,
              max_payout_per_round, result_mode,
              is_hot, hot_priority, is_jackpot_badge,
              display_category, is_active, created_at, updated_at
       FROM games WHERE id = $1`,
      [gameId],
    );
    if (!games.length) throw new NotFoundException('Game not found');

    const summary = await this.dataSource.query(
      `SELECT
         (SELECT COUNT(*)::int FROM game_rounds
           WHERE game_id = $1 AND status = 'OPEN' AND close_time > NOW())
         AS open_rounds_count,
         (SELECT COUNT(*)::int FROM game_hot_numbers
           WHERE game_id = $1 AND is_active = TRUE)
         AS active_hot_numbers_count`,
      [gameId],
    );

    return {
      ...games[0],
      summary: summary[0],
    };
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: HOT GAMES SHORTCUT
  // ═════════════════════════════════════════════════════════════
  async listHotGames() {
    return this.dataSource.query(
      `SELECT id, code, name, description, thumbnail_url,
              digit_length, min_bet, max_bet, payout_multiplier,
              hot_priority, is_jackpot_badge, display_category
       FROM games
       WHERE is_active = TRUE AND is_hot = TRUE
       ORDER BY hot_priority DESC, id ASC`,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: JACKPOT-BADGED GAMES SHORTCUT
  // ═════════════════════════════════════════════════════════════
  async listJackpotGames() {
    return this.dataSource.query(
      `SELECT id, code, name, description, thumbnail_url,
              digit_length, min_bet, max_bet, payout_multiplier,
              max_payout_per_round, hot_priority
       FROM games
       WHERE is_active = TRUE AND is_jackpot_badge = TRUE
       ORDER BY hot_priority DESC, id ASC`,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: GAMES BY DIGIT LENGTH (1D / 3D / 4D / 5D)
  //   Convenience shortcut — same data as listGames + digitLength filter.
  // ═════════════════════════════════════════════════════════════
  async listGamesByDigitLength(digitLength: DigitLength) {
    return this.dataSource.query(
      `SELECT id, code, name, description, thumbnail_url,
              digit_length, min_bet, max_bet, payout_multiplier,
              max_payout_per_round, hot_priority,
              is_hot, is_jackpot_badge, display_category
       FROM games
       WHERE is_active = TRUE AND digit_length = $1
       ORDER BY is_hot DESC, hot_priority DESC, id ASC`,
      [digitLength],
    );
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║                   ROUNDS LISTING                          ║
  // ╚═══════════════════════════════════════════════════════════╝

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: LIST ROUNDS FOR A GAME
  //   Filterable by status (OPEN, CLOSED, RESULT_PUBLISHED, SETTLED)
  // ═════════════════════════════════════════════════════════════
  async listRoundsForGame(gameId: number, q: ListRoundsQueryDto) {
    // Verify game exists
    const game = await this.dataSource.query(
      `SELECT id FROM games WHERE id = $1`, [gameId],
    );
    if (!game.length) throw new NotFoundException('Game not found');

    const where: string[] = [`gr.game_id = $1`];
    const params: any[] = [gameId];
    let i = 2;

    if (q.status) {
      where.push(`gr.status = $${i++}`);
      params.push(q.status);
    }

    const limit = q.limit ?? 20;
    params.push(limit);

    return this.dataSource.query(
      `SELECT gr.id, gr.game_id, gr.round_code, gr.open_time,
              gr.close_time, gr.draw_time, gr.status, gr.created_at,
              res.result_number AS result_number,
              res.created_at    AS result_announced_at,
              (SELECT COUNT(*)::int FROM bets b WHERE b.round_id = gr.id) AS total_bets
       FROM game_rounds gr
       LEFT JOIN game_results res ON res.round_id = gr.id
       WHERE ${where.join(' AND ')}
       ORDER BY gr.open_time DESC
       LIMIT $${i}`,
      params,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: ACTIVE ROUNDS FOR A GAME
  //   "Active" = OPEN status AND close_time still in the future.
  //   This is what users need to know "where can I bet right now?"
  // ═════════════════════════════════════════════════════════════
  async getActiveRoundsForGame(gameId: number) {
    return this.dataSource.query(
      `SELECT id, round_code, open_time, close_time, draw_time, status,
              EXTRACT(EPOCH FROM (close_time - NOW()))::int AS seconds_until_close
       FROM game_rounds
       WHERE game_id = $1
         AND status = 'OPEN'
         AND close_time > NOW()
       ORDER BY close_time ASC`,
      [gameId],
    );
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║                   RESULTS LISTING                         ║
  // ╚═══════════════════════════════════════════════════════════╝

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: RECENT RESULTS FOR A GAME
  //   For the "past results" page users browse.
  // ═════════════════════════════════════════════════════════════
  async getRecentResultsForGame(gameId: number, limit = 20) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return this.dataSource.query(
      `SELECT res.id AS result_id, res.round_id, res.result_number, res.created_at AS announced_at,
              gr.round_code, gr.open_time, gr.close_time, gr.draw_time, gr.status
       FROM game_results res
       JOIN game_rounds gr ON gr.id = res.round_id
       WHERE res.game_id = $1
       ORDER BY res.created_at DESC
       LIMIT $2`,
      [gameId, safeLimit],
    );
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: RESULT FOR A SPECIFIC ROUND
  // ═════════════════════════════════════════════════════════════
  async getRoundResult(roundId: number) {
    const rows = await this.dataSource.query(
      `SELECT res.id AS result_id, res.round_id, res.result_number, res.created_at AS announced_at,
              gr.round_code, gr.game_id, gr.status,
              g.name AS game_name, g.digit_length
       FROM game_results res
       JOIN game_rounds gr ON gr.id = res.round_id
       JOIN games g ON g.id = res.game_id
       WHERE res.round_id = $1
       LIMIT 1`,
      [roundId],
    );
    if (!rows.length) {
      // Either round doesn't exist or result not yet announced
      const round = await this.dataSource.query(
        `SELECT id, status FROM game_rounds WHERE id = $1`, [roundId],
      );
      if (!round.length) throw new NotFoundException('Round not found');
      return {
        round_id: roundId,
        status: round[0].status,
        result_announced: false,
        message: `Result not yet published (round status: ${round[0].status})`,
      };
    }
    return { ...rows[0], result_announced: true };
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║                   HOT NUMBERS                             ║
  // ╚═══════════════════════════════════════════════════════════╝

  async listHotNumbersForGame(gameId: number) {
    return this.dataSource.query(
      `SELECT id, number, note, priority
       FROM game_hot_numbers
       WHERE game_id = $1 AND is_active = TRUE
       ORDER BY priority DESC, id ASC`,
      [gameId],
    );
  }

  async adminListHotNumbers(gameId: number, includeInactive = false) {
    const where = includeInactive
      ? `game_id = $1`
      : `game_id = $1 AND is_active = TRUE`;
    return this.dataSource.query(
      `SELECT * FROM game_hot_numbers
       WHERE ${where}
       ORDER BY is_active DESC, priority DESC, id ASC`,
      [gameId],
    );
  }

  async createHotNumber(dto: CreateHotNumberDto, adminId: number) {
    const games = await this.dataSource.query(
      `SELECT id, digit_length FROM games WHERE id = $1`,
      [dto.gameId],
    );
    if (!games.length) throw new NotFoundException('Game not found');

    if (String(dto.number).length !== Number(games[0].digit_length)) {
      throw new BadRequestException(
        `Number must be exactly ${games[0].digit_length} digit(s) for this game`,
      );
    }

    try {
      const result = await this.dataSource.query(
        `INSERT INTO game_hot_numbers
          (game_id, number, priority, note, is_active, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          dto.gameId,
          dto.number,
          dto.priority ?? 0,
          dto.note ?? null,
          dto.isActive ?? true,
          adminId,
        ],
      );
      return result[0];
    } catch (e: any) {
      if (e.code === '23505') {
        throw new BadRequestException(
          `Number "${dto.number}" already exists for this game`,
        );
      }
      throw e;
    }
  }

  async updateHotNumber(id: number, dto: UpdateHotNumberDto) {
    const existing = await this.dataSource.query(
      `SELECT hn.*, g.digit_length
       FROM game_hot_numbers hn
       JOIN games g ON g.id = hn.game_id
       WHERE hn.id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Hot number not found');

    if (dto.number && String(dto.number).length !== Number(existing[0].digit_length)) {
      throw new BadRequestException(
        `Number must be ${existing[0].digit_length} digit(s) for this game`,
      );
    }

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    const map: Record<string, any> = {
      number:    dto.number,
      priority:  dto.priority,
      note:      dto.note,
      is_active: dto.isActive,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(id);

    try {
      const result = await this.dataSource.query(
        `UPDATE game_hot_numbers SET ${fields.join(', ')}
         WHERE id = $${i} RETURNING *`,
        values,
      );
      return result[0];
    } catch (e: any) {
      if (e.code === '23505') {
        throw new BadRequestException('That number already exists for this game');
      }
      throw e;
    }
  }

  async deleteHotNumber(id: number) {
    const result = await this.dataSource.query(
      `DELETE FROM game_hot_numbers WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!result.length) throw new NotFoundException('Hot number not found');
    return { message: 'Hot number deleted' };
  }

  async toggleHotNumber(id: number) {
    const result = await this.dataSource.query(
      `UPDATE game_hot_numbers
       SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    if (!result.length) throw new NotFoundException('Hot number not found');
    return result[0];
  }

  async reorderHotNumbers(dto: ReorderHotNumbersDto) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      for (const item of dto.items) {
        if (!Number.isFinite(item.id) || !Number.isFinite(item.priority)) {
          throw new BadRequestException('Each item needs id and priority');
        }
        await qr.query(
          `UPDATE game_hot_numbers
           SET priority = $1, updated_at = NOW()
           WHERE id = $2`,
          [item.priority, item.id],
        );
      }
      await qr.commitTransaction();
      return { message: 'Reorder applied', count: dto.items.length };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: UPDATE GAME FLAGS
  // ═════════════════════════════════════════════════════════════
  async updateGameFlags(gameId: number, dto: UpdateGameFlagsDto) {
    const existing = await this.dataSource.query(
      `SELECT id FROM games WHERE id = $1`, [gameId],
    );
    if (!existing.length) throw new NotFoundException('Game not found');

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    const map: Record<string, any> = {
      is_hot:               dto.isHot,
      is_jackpot_badge:     dto.isJackpotBadge,
      is_active:            dto.isActive,
      display_category:     dto.displayCategory,
      hot_priority:         dto.hotPriority,
      max_payout_per_round: dto.maxPayoutPerRound,
      description:          dto.description,
      thumbnail_url:        dto.thumbnailUrl,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(gameId);

    const result = await this.dataSource.query(
      `UPDATE games SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return result[0];
  }
}
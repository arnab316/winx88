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
  Logger
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import { TurnoverService } from '../turnover/turnover.service';
import { GamesGateway } from './games.gateway';

import {
  UpdateGameFlagsDto,
  UpdateGameSettingsDto,
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
  private readonly logger = new Logger(GameService.name)
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

      // Automatically settle the round immediately after publishing result
      try {
        await this.settleRound(round_id, result_number);
      } catch (settleErr) {
        this.logger.error(`Failed to auto-settle round ${round_id}: ${settleErr.message}`, settleErr.stack);
      }

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
      if (rounds[0].status !== 'OPEN' && rounds[0].status !== 'PLACED') {
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
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PLACED')
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
           AND result_status IN ('PLACED')`,
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
 
    if (q.isActive !== undefined) {
      where.push(`g.is_active = $${i++}`);
      params.push(q.isActive);
    } else {
      where.push(`g.is_active = TRUE`);
    }
    if (q.isHot !== undefined) {
      where.push(`g.is_hot = $${i++}`);
      params.push(q.isHot);
    }
    if (q.isJackpotBadge !== undefined) {
      where.push(`g.is_jackpot_badge = $${i++}`);
      params.push(q.isJackpotBadge);
    }
    if (q.category) {
      where.push(`g.display_category = $${i++}`);
      params.push(q.category);
    }
    if (q.digitLength) {
      where.push(`g.digit_length = $${i++}`);
      params.push(q.digitLength);
    }
    // liveOnly=true: only games with an OPEN round right now
    // Filters on the LATERAL join result (ar.id IS NOT NULL)
    if (q.liveOnly === true) {
      where.push(`ar.id IS NOT NULL`);
    }
 
    const whereSql = `WHERE ${where.join(' AND ')}`;
 
    const rows = await this.dataSource.query(
      `SELECT
         g.id, g.code, g.name, g.description, g.thumbnail_url,
         g.digit_length, g.min_bet, g.max_bet, g.payout_multiplier,
         g.max_payout_per_round, g.result_mode,
         g.is_hot, g.hot_priority, g.is_jackpot_badge,
         g.display_category, g.is_active, g.created_at, g.updated_at,
 
         -- Active round (where user can bet RIGHT NOW)
         ar.id                                                    AS active_round_id,
         ar.round_code                                            AS active_round_code,
         ar.open_time                                             AS active_round_open,
         ar.close_time                                            AS active_round_close,
         ar.draw_time                                             AS active_round_draw,
         EXTRACT(EPOCH FROM (ar.close_time - NOW()))::int         AS active_round_seconds_left,
 
         -- Jackpot pool (if game has jackpot badge + active pool)
         jp.id            AS jackpot_pool_id,
         jp.name_en       AS jackpot_pool_name,
         jp.prize_amount  AS jackpot_prize_amount,
         jp.currency      AS jackpot_currency,
         jp.ends_at       AS jackpot_ends_at
 
       FROM games g
 
       -- Closest OPEN round that hasn't closed yet
       LEFT JOIN LATERAL (
         SELECT id, round_code, open_time, close_time, draw_time
         FROM game_rounds
         WHERE game_id = g.id
           AND status = 'OPEN'
           AND close_time > NOW()
         ORDER BY close_time ASC
         LIMIT 1
       ) ar ON true
 
       -- Active jackpot pool (only for jackpot-badged games)
       LEFT JOIN LATERAL (
         SELECT id, name_en, prize_amount, currency, ends_at
         FROM jackpot_pools
         WHERE status = 'ACTIVE'
           AND starts_at <= NOW()
           AND ends_at > NOW()
         ORDER BY ends_at ASC
         LIMIT 1
       ) jp ON g.is_jackpot_badge = TRUE
 
       ${whereSql}
       ORDER BY
         g.is_hot DESC,
         g.hot_priority DESC,
         g.display_category ASC,
         g.id ASC`,
      params,
    );
 
    return rows.map((g: any) => ({
      id:               Number(g.id),
      code:             g.code,
      name:             g.name,
      description:      g.description,
      thumbnailUrl:     g.thumbnail_url,
      digitLength:      Number(g.digit_length),
      minBet:           parseFloat(g.min_bet),
      maxBet:           parseFloat(g.max_bet),
      payoutMultiplier: parseFloat(g.payout_multiplier),
      maxPayoutPerRound: g.max_payout_per_round ? parseFloat(g.max_payout_per_round) : null,
      isHot:            g.is_hot,
      hotPriority:      g.hot_priority,
      isJackpotBadge:   g.is_jackpot_badge,
      displayCategory:  g.display_category,
      isActive:         g.is_active,
 
      // ← THE KEY ADDITION: active round info
      // activeRound is null if game has no open round right now
      activeRound: g.active_round_id ? {
        id:              Number(g.active_round_id),   // ← pass this as round_id in POST /games/bet
        roundCode:       g.active_round_code,
        openTime:        g.active_round_open,
        closeTime:       g.active_round_close,
        drawTime:        g.active_round_draw,
        secondsUntilClose: Number(g.active_round_seconds_left),
        canBet:          Number(g.active_round_seconds_left) > 0,
      } : null,
 
      // Jackpot pool info
      jackpot: g.jackpot_pool_id ? {
        poolId:      Number(g.jackpot_pool_id),
        name:        g.jackpot_pool_name,
        prizeAmount: parseFloat(g.jackpot_prize_amount),
        currency:    g.jackpot_currency,
        endsAt:      g.jackpot_ends_at,
      } : null,
    }));
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
 
    // Date filter — 'today' shortcut or explicit YYYY-MM-DD
    if ((q as any).date) {
      const dateVal: string = (q as any).date;
      let targetDate: string;
 
      if (dateVal.toLowerCase() === 'today') {
        targetDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
        targetDate = dateVal;
      } else {
        throw new BadRequestException('date must be "today" or YYYY-MM-DD format');
      }
 
      // Match rounds whose draw_time falls on the target date (server timezone UTC)
      where.push(`gr.draw_time::date = $${i++}::date`);
      params.push(targetDate);
    }
 
    const limit = Math.min(q.limit ?? 50, 200);
    params.push(limit);
 
    const rows = await this.dataSource.query(
      `SELECT
         gr.id, gr.game_id, gr.round_code,
         gr.open_time, gr.close_time, gr.draw_time,
         gr.status, gr.created_at,
         res.result_number,
         res.created_at AS result_announced_at,
         (SELECT COUNT(*)::int FROM bets b WHERE b.round_id = gr.id) AS total_bets,
         -- Derive UI-friendly status label
         CASE
           WHEN gr.status = 'SETTLED' THEN 'Completed'
           WHEN gr.status = 'RESULT_PUBLISHED' THEN 'Completed'
           WHEN gr.status = 'CLOSED' THEN 'Processing'
           WHEN gr.status = 'OPEN' AND gr.open_time > NOW() THEN 'Upcoming'
           WHEN gr.status = 'OPEN' AND gr.close_time > NOW() THEN 'Live'
           WHEN gr.status = 'OPEN' AND gr.close_time <= NOW() THEN 'Closing'
           ELSE gr.status
         END AS display_status
       FROM game_rounds gr
       LEFT JOIN game_results res ON res.round_id = gr.id
       WHERE ${where.join(' AND ')}
       ORDER BY gr.draw_time ASC
       LIMIT $${i}`,
      params,
    );
 
    return rows;
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
    // Suggestions stay visible for the whole 24h window (expires_at), NOT tied
    // to a live round — so they don't disappear during the gap between rounds.
    // Hidden only when expired, deactivated, or the game's schedule is paused.
    return this.dataSource.query(
      `SELECT id, number, note, priority,
              expires_at,
              EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS seconds_until_expiry
       FROM game_hot_numbers hn
       WHERE hn.game_id = $1
         AND hn.is_active = TRUE
         AND (hn.expires_at IS NULL OR hn.expires_at > NOW())
         AND NOT EXISTS (
           SELECT 1 FROM game_schedules gs
           WHERE gs.game_id = hn.game_id AND gs.is_active = FALSE
         )
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
          (game_id, number, priority, note, is_active, created_by_admin_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '24 hours')
         RETURNING *,
           EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS seconds_until_expiry`,
        [
          dto.gameId,
          dto.number,
          dto.priority ?? 0,
          dto.note ?? null,
          dto.isActive ?? true,
          adminId,
        ],
      );
      const created = result[0];
      await this.emitHotNumbersChange(dto.gameId, 'added');
      return created;
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
    const row = await this.dataSource.query(
      `SELECT game_id FROM game_hot_numbers WHERE id = $1`,
      [id],
    );
    if (!row.length) throw new NotFoundException('Hot number not found');
    const gameId = Number(row[0].game_id);
    await this.dataSource.query(
      `DELETE FROM game_hot_numbers WHERE id = $1`,
      [id],
    );
    await this.emitHotNumbersChange(gameId, 'deleted');
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
    await this.emitHotNumbersChange(Number(result[0].game_id), 'toggled');
    return result[0];
  }


  // ── PRIVATE: fetch current hot numbers and emit WS event ──
  private async emitHotNumbersChange(
    gameId: number,
    action: 'added' | 'deleted' | 'toggled' | 'expired',
  ): Promise<void> {
    try {
      const hotNumbers = await this.dataSource.query(
        `SELECT id, number, expires_at,
                EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS seconds_until_expiry
         FROM game_hot_numbers
         WHERE game_id = $1
           AND (expires_at IS NULL OR expires_at > NOW())
           AND EXISTS (
             SELECT 1 FROM game_rounds gr
             WHERE gr.game_id = $1
               AND gr.status = 'OPEN'
               AND gr.close_time > NOW()
           )
         ORDER BY priority DESC, id ASC`,
        [gameId],
      );
      this.gateway.emitHotNumbersUpdated({ gameId, action, hotNumbers });
    } catch (e) {
      // Non-blocking — hot number emit failure never breaks the main operation
    }
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

  // ═════════════════════════════════════════════════════════════
  // ADMIN: UPDATE GAME SETTINGS (economics)
  //   Updates payout_multiplier, min_bet, max_bet, max_payout_per_round,
  //   name. Partial update — only provided fields change.
  //   NOTE: changing payout_multiplier only affects FUTURE bets;
  //   each bet snapshots its own multiplier at placement time.
  //
  //   PATCH /games/admin/:id/settings
  // ═════════════════════════════════════════════════════════════
  async updateGameSettings(gameId: number, dto: UpdateGameSettingsDto) {
    const existing = await this.dataSource.query(
      `SELECT id, min_bet, max_bet FROM games WHERE id = $1`, [gameId],
    );
    if (!existing.length) throw new NotFoundException('Game not found');

    // Resolve effective min/max (incoming value wins, else current) to validate range.
    const effMin = dto.minBet ?? parseFloat(existing[0].min_bet);
    const effMax = dto.maxBet ?? parseFloat(existing[0].max_bet);
    if (effMin > effMax) {
      throw new BadRequestException('min_bet cannot be greater than max_bet');
    }

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    const map: Record<string, any> = {
      name:                 dto.name,
      payout_multiplier:    dto.payoutMultiplier,
      min_bet:              dto.minBet,
      max_bet:              dto.maxBet,
      max_payout_per_round: dto.maxPayoutPerRound,
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


  // ═════════════════════════════════════════════════════════════
  // ADMIN: ROUND NUMBER STATS
  //   Shows every number that has been bet on in this round,
  //   sorted by potential payout (highest risk first).
  //   Admin uses this to decide what result number to publish.
  //
  //   GET /games/admin/rounds/:roundId/stats
  // ═════════════════════════════════════════════════════════════
  async getRoundStats(roundId: number) {
    // 1. Get round + game info
    const roundRows = await this.dataSource.query(
      `SELECT
         gr.id, gr.round_code, gr.game_id, gr.status,
         gr.open_time, gr.close_time, gr.draw_time,
         g.name AS game_name, g.digit_length,
         g.payout_multiplier, g.max_payout_per_round
       FROM game_rounds gr
       JOIN games g ON g.id = gr.game_id
       WHERE gr.id = $1`,
      [roundId],
    );
    if (!roundRows.length) throw new NotFoundException('Round not found');
    const round = roundRows[0];
    const multiplier = parseFloat(round.payout_multiplier);
 
    // 2. Number breakdown from game_number_stats
    //    Joined with hot_numbers so admin sees which are "hot"
    const stats = await this.dataSource.query(
      `SELECT
         gns.bet_number,
         gns.total_bets,
         gns.total_amount::numeric                        AS total_staked,
         (gns.total_amount * $2)::numeric                 AS potential_payout,
         hn.id IS NOT NULL                                AS is_hot_number,
         hn.note                                          AS hot_note
       FROM game_number_stats gns
       LEFT JOIN game_hot_numbers hn
         ON hn.game_id = gns.game_id
        AND hn.number  = gns.bet_number
        AND hn.is_active = TRUE
       WHERE gns.round_id = $1
       ORDER BY (gns.total_amount * $2) DESC`,   
      [roundId, multiplier],
    );
 
    // 3. Totals across all numbers
    const totals = await this.dataSource.query(
      `SELECT
         COUNT(DISTINCT b.user_id)::int                   AS unique_bettors,
         COUNT(b.id)::int                                 AS total_bets,
         COALESCE(SUM(b.bet_amount), 0)::numeric          AS total_staked,
         COALESCE(SUM(b.potential_payout), 0)::numeric    AS max_total_payout,
         COUNT(DISTINCT b.bet_number)::int                AS unique_numbers_bet
       FROM bets b
       WHERE b.round_id = $1
         AND b.result_status IN ('PENDING', 'OPEN')`,
      [roundId],
    );
 
    // 4. Safest number to pick (lowest payout liability)
    //    Useful hint — not a mandate
    const safest = stats.length
      ? stats[stats.length - 1]   // last row = lowest liability (sorted DESC above)
      : null;
 
    // 5. Highest risk number
    const riskiest = stats.length ? stats[0] : null;
 
    return {
      round: {
        id:               Number(round.id),
        roundCode:        round.round_code,
        gameId:           Number(round.game_id),
        gameName:         round.game_name,
        digitLength:      Number(round.digit_length),
        payoutMultiplier: multiplier,
        maxPayoutPerRound: round.max_payout_per_round
          ? parseFloat(round.max_payout_per_round) : null,
        status:    round.status,
        openTime:  round.open_time,
        closeTime: round.close_time,
        drawTime:  round.draw_time,
      },
      summary: {
        uniqueBettors:      totals[0].unique_bettors,
        totalBets:          totals[0].total_bets,
        totalStaked:        parseFloat(totals[0].total_staked),
        maxTotalPayout:     parseFloat(totals[0].max_total_payout),
        uniqueNumbersBet:   totals[0].unique_numbers_bet,
        capRemaining: round.max_payout_per_round
          ? Math.max(0, parseFloat(round.max_payout_per_round) - parseFloat(totals[0].max_total_payout))
          : null,
      },
      insight: {
        riskiestNumber: riskiest ? {
          number:         riskiest.bet_number,
          potentialPayout: parseFloat(riskiest.potential_payout),
          totalBets:      Number(riskiest.total_bets),
        } : null,
        safestNumber: safest && safest !== riskiest ? {
          number:         safest.bet_number,
          potentialPayout: parseFloat(safest.potential_payout),
          totalBets:      Number(safest.total_bets),
        } : null,
      },
      // Full number-by-number breakdown sorted by payout liability (highest first)
      numbers: stats.map((s: any) => ({
        number:          s.bet_number,
        totalBets:       Number(s.total_bets),
        totalStaked:     parseFloat(s.total_staked),
        potentialPayout: parseFloat(s.potential_payout),
        isHotNumber:     s.is_hot_number,
        hotNote:         s.hot_note ?? null,
      })),
    };
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN: ALL ROUNDS STATS FOR A GAME (overview list)
  //   Shows all rounds with their betting summary.
  //   Admin picks which round to inspect in detail.
  //
  //   GET /games/admin/:gameId/rounds-overview
  // ═════════════════════════════════════════════════════════════
  async getGameRoundsOverview(gameId: number, status?: string) {
    const game = await this.dataSource.query(
      `SELECT id, name, payout_multiplier FROM games WHERE id = $1`,
      [gameId],
    );
    if (!game.length) throw new NotFoundException('Game not found');
 
    const where = status
      ? `WHERE gr.game_id = $1 AND gr.status = $2`
      : `WHERE gr.game_id = $1`;
    const params = status ? [gameId, status] : [gameId];
 
    const rounds = await this.dataSource.query(
      `SELECT
         gr.id, gr.round_code, gr.status,
         gr.open_time, gr.close_time, gr.draw_time,
         res.result_number,
         COUNT(b.id)::int                              AS total_bets,
         COUNT(DISTINCT b.user_id)::int                AS unique_bettors,
         COALESCE(SUM(b.bet_amount), 0)::numeric       AS total_staked,
         COALESCE(SUM(b.potential_payout), 0)::numeric AS max_payout_liability,
         COUNT(DISTINCT b.bet_number)::int             AS unique_numbers
       FROM game_rounds gr
       LEFT JOIN bets b
         ON b.round_id = gr.id AND b.result_status IN ('PENDING','OPEN','WON','LOST')
       LEFT JOIN game_results res ON res.round_id = gr.id
       ${where}
       GROUP BY gr.id, res.result_number
       ORDER BY gr.open_time DESC
       LIMIT 50`,
      params,
    );
 
    return {
      gameId:   Number(gameId),
      gameName: game[0].name,
      rounds:   rounds.map((r: any) => ({
        roundId:           Number(r.id),
        roundCode:         r.round_code,
        status:            r.status,
        openTime:          r.open_time,
        closeTime:         r.close_time,
        drawTime:          r.draw_time,
        resultNumber:      r.result_number ?? null,
        totalBets:         Number(r.total_bets),
        uniqueBettors:     Number(r.unique_bettors),
        totalStaked:       parseFloat(r.total_staked),
        maxPayoutLiability: parseFloat(r.max_payout_liability),
        uniqueNumbers:     Number(r.unique_numbers),
      })),
    };
  
  }


   async createGameWithRound(payload: {
    // Game fields
    code: string;
    name: string;
    digit_length: number;
    min_bet: number;
    max_bet: number;
    payout_multiplier: number;
    // Optional game fields (G1)
    description?: string;
    thumbnail_url?: string;
    display_category?: string;
    max_payout_per_round?: number;
    // Round fields
    round_code: string;
    open_time: string;
    close_time: string;
    draw_time: string;
  }) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
 
    try {
      // 1. Create game
      const gameRows = await qr.query(
        `INSERT INTO games
           (code, name, digit_length, min_bet, max_bet, payout_multiplier,
            description, thumbnail_url, display_category, max_payout_per_round,
            is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
         RETURNING *`,
        [
          payload.code,
          payload.name,
          payload.digit_length,
          payload.min_bet,
          payload.max_bet,
          payload.payout_multiplier,
          payload.description     ?? null,
          payload.thumbnail_url   ?? null,
          payload.display_category ?? 'REGULAR',
          payload.max_payout_per_round ?? null,
        ],
      );
      const game = gameRows[0];
 
      // 2. Validate times
      const openTime  = new Date(payload.open_time);
      const closeTime = new Date(payload.close_time);
      const drawTime  = new Date(payload.draw_time);
 
      if (closeTime <= openTime) {
        throw new BadRequestException('close_time must be after open_time');
      }
      if (drawTime < closeTime) {
        throw new BadRequestException('draw_time must be >= close_time');
      }
 
      // 3. Create first round
      const roundRows = await qr.query(
        `INSERT INTO game_rounds
           (game_id, round_code, open_time, close_time, draw_time, status)
         VALUES ($1,$2,$3,$4,$5,'OPEN')
         RETURNING *`,
        [
          game.id,
          payload.round_code,
          payload.open_time,
          payload.close_time,
          payload.draw_time,
        ],
      );
      const round = roundRows[0];
 
      await qr.commitTransaction();
 
      // Emit WS event after commit
      this.gateway.emitRoundOpened({
        gameId:    Number(game.id),
        roundId:   Number(round.id),
        roundCode: round.round_code,
        openTime:  round.open_time,
        closeTime: round.close_time,
        drawTime:  round.draw_time,
      });
 
      return { game, round };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }
  // ═════════════════════════════════════════════════════════════
  // ADMIN: CREATE ROUND FOR EXISTING GAME
  //   Standalone — admin adds more rounds after the first one.
  //   POST /games/admin/create-round
  // ═════════════════════════════════════════════════════════════
  async adminCreateRound(payload: {
    game_id: number;
    round_code: string;
    open_time: string;
    close_time: string;
    draw_time: string;
  }) {
    // Verify game exists
    const game = await this.dataSource.query(
      `SELECT id, name FROM games WHERE id = $1 AND is_active = true`,
      [payload.game_id],
    );
    if (!game.length) throw new NotFoundException('Game not found or inactive');
 
    // Validate times
    const openTime  = new Date(payload.open_time);
    const closeTime = new Date(payload.close_time);
    const drawTime  = new Date(payload.draw_time);
 
    if (closeTime <= openTime) {
      throw new BadRequestException('close_time must be after open_time');
    }
    if (drawTime < closeTime) {
      throw new BadRequestException('draw_time must be >= close_time');
    }
 
    // NOTE: round codes are intentionally repeatable (a per-game series that
    // stays the same until the admin changes it), so we no longer reject a
    // code that already exists for this game.
 
    const rows = await this.dataSource.query(
      `INSERT INTO game_rounds
         (game_id, round_code, open_time, close_time, draw_time, status)
       VALUES ($1,$2,$3,$4,$5,'OPEN')
       RETURNING *`,
      [payload.game_id, payload.round_code, payload.open_time, payload.close_time, payload.draw_time],
    );
    const round = rows[0];
 
    // Emit WS
    this.gateway.emitRoundOpened({
      gameId:    Number(round.game_id),
      roundId:   Number(round.id),
      roundCode: round.round_code,
      openTime:  round.open_time,
      closeTime: round.close_time,
      drawTime:  round.draw_time,
    });
 
    return { game: game[0], round };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: SET THE GAME'S ROUND CODE
  //   The code applied to every NEW round of this game. It repeats until
  //   changed; changing it does NOT touch the currently open round — it
  //   takes effect on the next round that opens.
  //   PATCH /games/admin/:gameId/round-code
  // ═════════════════════════════════════════════════════════════
  async setRoundCode(gameId: number, roundCode: string) {
    const code = (roundCode ?? '').trim();
    if (code.length < 1 || code.length > 40) {
      throw new BadRequestException('roundCode must be 1–40 characters');
    }

    const rows = await this.dataSource.query(
      `UPDATE games SET round_code = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, code, name, round_code, round_mode`,
      [code, gameId],
    );
    if (!rows.length) throw new NotFoundException('Game not found');

    return {
      message: 'Round code updated. It applies to the next round that opens.',
      game: rows[0],
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CHANGE A GAME'S CODE (games.code)
  //   Works for any game. The code is UNIQUE across games, so a clash
  //   returns 400. Trimmed; case preserved.
  //   PATCH /games/admin/:id/code
  // ═════════════════════════════════════════════════════════════
  async updateGameCode(gameId: number, code: string) {
    const newCode = (code ?? '').trim();
    if (newCode.length < 1 || newCode.length > 50) {
      throw new BadRequestException('code must be 1–50 characters');
    }

    const exists = await this.dataSource.query(
      `SELECT id, code FROM games WHERE id = $1`,
      [gameId],
    );
    if (!exists.length) throw new NotFoundException('Game not found');

    // Pre-check the unique clash for a clean message (the DB constraint is the
    // real guard against races).
    const clash = await this.dataSource.query(
      `SELECT id FROM games WHERE code = $1 AND id <> $2 LIMIT 1`,
      [newCode, gameId],
    );
    if (clash.length) {
      throw new BadRequestException(`Game code "${newCode}" is already in use`);
    }

    try {
      const rows = await this.dataSource.query(
        `UPDATE games SET code = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, code, name, digit_length, round_mode`,
        [newCode, gameId],
      );
      return {
        message: 'Game code updated',
        previousCode: exists[0].code,
        game: rows[0],
      };
    } catch (e: any) {
      if (e.code === '23505') {
        throw new BadRequestException(`Game code "${newCode}" is already in use`);
      }
      throw e;
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: OPEN THE NEXT ROUND (MANUAL games — 4D / 5D)
  //   Closes the current OPEN round (if any) and opens a fresh one using
  //   the game's saved round_code. The round never auto-closes (the
  //   round-watcher skips MANUAL games) — admin advances it by calling
  //   this again. Settle the closed round via the existing result flow.
  //   POST /games/admin/:gameId/open-round
  // ═════════════════════════════════════════════════════════════
  async openManualRound(gameId: number) {
    const games = await this.dataSource.query(
      `SELECT id, name, round_code, round_mode, is_active FROM games WHERE id = $1`,
      [gameId],
    );
    if (!games.length) throw new NotFoundException('Game not found');
    const game = games[0];

    if (game.round_mode !== 'MANUAL') {
      throw new BadRequestException(
        `Game is ${game.round_mode}. open-round is only for MANUAL games.`,
      );
    }
    if (!game.is_active) throw new BadRequestException('Game is inactive');
    if (!game.round_code || !String(game.round_code).trim()) {
      throw new BadRequestException(
        'Set a round code first (PATCH /games/admin/:gameId/round-code).',
      );
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // Close any currently OPEN round for this game (only one live at a time).
      const closed = await qr.query(
        `UPDATE game_rounds SET status = 'CLOSED', close_time = NOW(), updated_at = NOW()
         WHERE game_id = $1 AND status = 'OPEN'
         RETURNING id, round_code`,
        [gameId],
      );

      // Open the new round. No auto-close: close/draw times are far in the
      // future so timer-based logic never closes it; admin controls it.
      const rows = await qr.query(
        `INSERT INTO game_rounds
           (game_id, round_code, open_time, close_time, draw_time, status, source)
         VALUES ($1, $2, NOW(),
                 NOW() + INTERVAL '100 years',
                 NOW() + INTERVAL '100 years',
                 'OPEN', 'MANUAL')
         RETURNING *`,
        [gameId, String(game.round_code).trim()],
      );
      const round = rows[0];

      await qr.commitTransaction();

      this.gateway.emitRoundOpened({
        gameId:    Number(round.game_id),
        roundId:   Number(round.id),
        roundCode: round.round_code,
        openTime:  round.open_time,
        closeTime: round.close_time,
        drawTime:  round.draw_time,
      });

      return {
        message: 'New round opened',
        roundCode: round.round_code,
        round,
        closedRound: closed.length
          ? { id: Number(closed[0].id), roundCode: closed[0].round_code }
          : null,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

 // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST ALL GAMES WITH ROUND INFO
  //   Returns each game with:
  //     - latest round (id, status, open/close/draw times)
  //     - active round count
  //     - total bets + staked across all rounds
  //     - quick stats for the UI table
  //
  //   GET /games/admin/list
  // ═════════════════════════════════════════════════════════════
  async adminListGames() {
    const games = await this.dataSource.query(
      `SELECT
         g.id, g.code, g.name, g.digit_length,
         g.min_bet, g.max_bet, g.payout_multiplier,
         g.max_payout_per_round,
         g.is_hot, g.is_jackpot_badge, g.display_category,
         g.is_active, g.created_at,
 
         -- Latest round info (most recently created)
         lr.id            AS latest_round_id,
         lr.round_code    AS latest_round_code,
         lr.status        AS latest_round_status,
         lr.open_time     AS latest_round_open,
         lr.close_time    AS latest_round_close,
         lr.draw_time     AS latest_round_draw,
 
         -- Counts
         (SELECT COUNT(*)::int FROM game_rounds gr
           WHERE gr.game_id = g.id)                              AS total_rounds,
         (SELECT COUNT(*)::int FROM game_rounds gr
           WHERE gr.game_id = g.id AND gr.status = 'OPEN'
             AND gr.close_time > NOW())                          AS active_rounds,
         (SELECT COUNT(*)::int FROM game_rounds gr
           WHERE gr.game_id = g.id AND gr.status = 'CLOSED')    AS closed_rounds,
 
         -- Bet stats across ALL rounds (lifetime)
         (SELECT COUNT(*)::int FROM bets b
           WHERE b.game_id = g.id)                              AS total_bets_all_time,
         (SELECT COALESCE(SUM(b.bet_amount),0)::numeric FROM bets b
           WHERE b.game_id = g.id)                              AS total_staked_all_time,
 
         -- Bet stats for latest round only
         (SELECT COUNT(*)::int FROM bets b
           WHERE b.round_id = lr.id)                            AS latest_round_bets,
         (SELECT COALESCE(SUM(b.bet_amount),0)::numeric FROM bets b
           WHERE b.round_id = lr.id AND b.result_status = 'PLACED') AS latest_round_staked,
         (SELECT COUNT(DISTINCT b.bet_number)::int FROM bets b
           WHERE b.round_id = lr.id AND b.result_status = 'PLACED') AS latest_round_unique_numbers
 
       FROM games g
       -- Get the most recently created round per game
       LEFT JOIN LATERAL (
         SELECT * FROM game_rounds gr
         WHERE gr.game_id = g.id
         ORDER BY gr.created_at DESC
         LIMIT 1
       ) lr ON true
 
       ORDER BY g.is_active DESC, g.created_at DESC`,
    );
 
    return games.map((g: any) => ({
      // Game core
      id:                  Number(g.id),
      code:                g.code,
      name:                g.name,
      digitLength:         Number(g.digit_length),
      minBet:              parseFloat(g.min_bet),
      maxBet:              parseFloat(g.max_bet),
      payoutMultiplier:    parseFloat(g.payout_multiplier),
      maxPayoutPerRound:   g.max_payout_per_round ? parseFloat(g.max_payout_per_round) : null,
      isHot:               g.is_hot,
      isJackpotBadge:      g.is_jackpot_badge,
      displayCategory:     g.display_category,
      isActive:            g.is_active,
      createdAt:           g.created_at,
 
      // Round summary
      rounds: {
        total:   Number(g.total_rounds),
        active:  Number(g.active_rounds),
        closed:  Number(g.closed_rounds),
      },
 
      // Latest round — what admin sees in the UI table
      latestRound: g.latest_round_id ? {
        id:         Number(g.latest_round_id),
        roundCode:  g.latest_round_code,
        status:     g.latest_round_status,
        openTime:   g.latest_round_open,
        closeTime:  g.latest_round_close,
        drawTime:   g.latest_round_draw,
        bets:       Number(g.latest_round_bets),
        staked:     parseFloat(g.latest_round_staked),
        uniqueNumbers: Number(g.latest_round_unique_numbers),
      } : null,
 
      // Lifetime stats
      allTime: {
        totalBets:   Number(g.total_bets_all_time),
        totalStaked: parseFloat(g.total_staked_all_time),
      },
    }));
  }
   // ═════════════════════════════════════════════════════════════
  // ADMIN: DELETE GAME
  //   Soft delete (is_active = false) by default.
  //   Hard delete only if game has zero bets ever — otherwise
  //   it would destroy financial history.
  //
  //   DELETE /games/admin/:id           → soft delete
  //   DELETE /games/admin/:id?hard=true → hard delete (blocked if bets exist)
  // ═════════════════════════════════════════════════════════════
  async deleteGame(gameId: number, hard = false) {
  const existing = await this.dataSource.query(
    `SELECT id, name, is_active FROM games WHERE id = $1`,
    [gameId],
  );

  if (!existing.length) {
    this.logger.warn(`deleteGame: game ${gameId} not found`);
    throw new NotFoundException(`Game #${gameId} not found`);
  }

  const game = existing[0];

  if (hard) {
    // Block hard delete if any bets exist for this game
    const betCount = await this.dataSource.query(
      `SELECT COUNT(*)::int AS cnt FROM bets WHERE game_id = $1`,
      [gameId],
    );

    if (betCount[0].cnt > 0) {
      this.logger.warn(
        `deleteGame: hard delete blocked for game ${gameId} (${game.name}) — ${betCount[0].cnt} bet(s) on record`,
      );
      throw new BadRequestException(
        `Cannot hard delete — "${game.name}" has ${betCount[0].cnt} bet(s) on record. ` +
        `Use soft delete to deactivate it instead.`,
      );
    }

    this.logger.log(
      `deleteGame: hard deleting game ${gameId} (${game.name}) — no bets on record`,
    );

    try {
      // Delete in FK-safe order so no foreign key constraint fires
      await this.dataSource.query(`DELETE FROM game_results    WHERE game_id = $1`, [gameId]);
      await this.dataSource.query(`DELETE FROM game_hot_numbers WHERE game_id = $1`, [gameId]);
      await this.dataSource.query(`DELETE FROM game_number_stats WHERE game_id = $1`, [gameId]);
      await this.dataSource.query(`DELETE FROM game_schedules  WHERE game_id = $1`, [gameId]);
      await this.dataSource.query(`DELETE FROM game_rounds     WHERE game_id = $1`, [gameId]);
      await this.dataSource.query(`DELETE FROM games           WHERE id = $1`,      [gameId]);
    } catch (err: any) {
      this.logger.error(
        `deleteGame: hard delete failed for game ${gameId} (${game.name}) — ${err?.message}`,
        err?.stack,
      );
      throw new BadRequestException(
        `Hard delete failed: ${err?.message ?? 'database error'}. ` +
        `Try soft delete instead.`,
      );
    }

    this.logger.log(`deleteGame: game ${gameId} (${game.name}) permanently deleted`);
    return {
      message: `Game "${game.name}" permanently deleted`,
      gameId,
    };
  }

  // ── Soft delete ──────────────────────────────────────────────
  this.logger.log(`deleteGame: soft deleting game ${gameId} (${game.name})`);

  try {
    // Close any open rounds first so no new bets can come in
    const closedRounds = await this.dataSource.query(
      `UPDATE game_rounds
       SET status = 'CLOSED', updated_at = NOW()
       WHERE game_id = $1 AND status = 'OPEN'
       RETURNING id`,
      [gameId],
    );

    await this.dataSource.query(
      `UPDATE games SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [gameId],
    );

    if (closedRounds.length) {
      this.logger.log(
        `deleteGame: closed ${closedRounds.length} open round(s) for game ${gameId}`,
      );
    }
  } catch (err: any) {
    this.logger.error(
      `deleteGame: soft delete failed for game ${gameId} — ${err?.message}`,
      err?.stack,
    );
    throw new BadRequestException(
      `Soft delete failed: ${err?.message ?? 'database error'}`,
    );
  }

  this.logger.log(`deleteGame: game ${gameId} (${game.name}) deactivated`);
  return {
    message: `Game "${game.name}" deactivated. All open rounds closed.`,
    gameId,
    tip: 'Use PATCH /games/admin/:id/flags with { "isActive": true } to reactivate.',
  };
}

   async getPublicResultsFeed(q: {
    hours?: number;
    gameId?: number;
    digitLength?: number;
    limit?: number;
  }) {
    // Clamp hours: default 24, max 168 (7 days)
    const hours   = Math.min(Math.max(Number(q.hours ?? 24), 1), 168);
    const limit   = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
 
    const where: string[] = [
      `res.created_at >= NOW() - ($1 || ' hours')::interval`,
      `gr.status IN ('RESULT_PUBLISHED', 'SETTLED')`,
    ];
    const params: any[] = [hours];
    let i = 2;
 
    if (q.gameId) {
      where.push(`res.game_id = $${i++}`);
      params.push(q.gameId);
    }
    if (q.digitLength) {
      where.push(`g.digit_length = $${i++}`);
      params.push(q.digitLength);
    }
 
    params.push(limit);
 
    const rows = await this.dataSource.query(
      `SELECT
         -- Game info
         g.id               AS game_id,
         g.name             AS game_name,
         g.digit_length,
         g.payout_multiplier,
 
         -- Round info
         gr.id              AS round_id,
         gr.round_code,
         gr.close_time,
         gr.draw_time,
         gr.status          AS round_status,
 
         -- Result
         res.result_number,
         res.created_at     AS result_announced_at,
 
         -- Bet stats for this round
         COUNT(b.id)::int                                              AS total_bets,
         COUNT(b.id) FILTER (WHERE b.result_status = 'WON')::int      AS total_winners,
         COALESCE(SUM(b.bet_amount), 0)::numeric                      AS total_staked,
         COALESCE(SUM(b.potential_payout)
           FILTER (WHERE b.result_status = 'WON'), 0)::numeric        AS total_paid_out
 
       FROM game_results res
       JOIN game_rounds gr ON gr.id = res.round_id
       JOIN games g        ON g.id  = res.game_id
       LEFT JOIN bets b    ON b.round_id = res.round_id
 
       WHERE ${where.join(' AND ')}
 
       GROUP BY
         g.id, g.name, g.digit_length, g.payout_multiplier,
         gr.id, gr.round_code, gr.close_time, gr.draw_time, gr.status,
         res.result_number, res.created_at
 
       ORDER BY res.created_at DESC
       LIMIT $${i}`,
      params,
    );
 
    const multiplier = 0; // placeholder — set per row below
 
    return {
      hoursShown: hours,
      count: rows.length,
      results: rows.map((r: any) => {
        const mult = parseFloat(r.payout_multiplier);
        // Example win calculation — "if you bet ৳100 on the winning number"
        const exampleBet = 100;
        const examplePayout = exampleBet * mult;
 
        return {
          gameId:       Number(r.game_id),
          gameName:     r.game_name,
          gameType:     `${r.digit_length}D`,       // "1D", "3D", "4D", "5D"
          digitLength:  Number(r.digit_length),
 
          roundId:      Number(r.round_id),
          roundCode:    r.round_code,
          drawTime:     r.draw_time,
          announcedAt:  r.result_announced_at,
 
          resultNumber: r.result_number,
 
          // Payout info — what users care about most
          multiplier:   mult,
          exampleWin: {
            betAmount:     exampleBet,
            resultAmount:  examplePayout,
            label: `Bet ৳${exampleBet} → Win ৳${examplePayout}`,
          },
 
          // Round stats
          stats: {
            totalBets:    Number(r.total_bets),
            totalWinners: Number(r.total_winners),
            totalStaked:  parseFloat(r.total_staked),
            totalPaidOut: parseFloat(r.total_paid_out),
          },
        };
      }),
    };
  }
 
  // ═════════════════════════════════════════════════════════════
  // USER: MY BET HISTORY
  //   Paginated list of all bets the logged-in user has placed.
  //
  //   GET /games/my-bets
  //   GET /games/my-bets?status=WON
  //   GET /games/my-bets?gameId=1
  //   GET /games/my-bets?page=1&limit=20
  // ═════════════════════════════════════════════════════════════
  async getUserBetHistory(userId: number, q: {
    status?:  string;   // WON | LOST | PLACED | CANCELLED
    gameId?:  number;
    page?:    number;
    limit?:   number;
  }) {
    const page  = Math.max(q.page  ?? 1, 1);
    const limit = Math.min(q.limit ?? 20, 100);
    const offset = (page - 1) * limit;
 
    const where: string[] = [`b.user_id = $1`];
    const params: any[]   = [userId];
    let i = 2;
 
    if (q.status) {
      where.push(`b.result_status = $${i++}`);
      params.push(q.status.toUpperCase());
    }
    if (q.gameId) {
      where.push(`b.game_id = $${i++}`);
      params.push(q.gameId);
    }
 
    params.push(limit, offset);
 
    const rows = await this.dataSource.query(
      `SELECT
         b.id             AS bet_id,
         b.bet_code,
         b.bet_number,
         b.bet_amount,
         b.payout_multiplier,
         b.potential_payout,
         b.result_status,
         b.placed_at,
         b.settled_at,
         b.ticket_url,
         -- Game info
         g.id             AS game_id,
         g.name           AS game_name,
         g.digit_length,
         -- Round info
         gr.id            AS round_id,
         gr.round_code,
         gr.draw_time,
         gr.status        AS round_status,
         -- Result (null if not announced yet)
         res.result_number,
         -- Did user win this bet?
         CASE
           WHEN b.result_status = 'WON'  THEN b.potential_payout
           WHEN b.result_status = 'LOST' THEN 0
           ELSE NULL
         END AS actual_payout
       FROM bets b
       JOIN games g        ON g.id  = b.game_id
       JOIN game_rounds gr ON gr.id = b.round_id
       LEFT JOIN game_results res ON res.round_id = b.round_id
       WHERE ${where.join(' AND ')}
       ORDER BY b.placed_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params,
    );
 
      const countRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total
       FROM bets b
       WHERE ${where.join(' AND ')}`,
      params.slice(0, -2),
    );
 
    // Summary stats for this filter set
    const statsRows = await this.dataSource.query(
      `SELECT
         COUNT(*)::int                                                  AS total_bets,
         COUNT(*) FILTER (WHERE b.result_status = 'WON')::int          AS total_wins,
         COUNT(*) FILTER (WHERE b.result_status = 'LOST')::int         AS total_losses,
         COUNT(*) FILTER (WHERE b.result_status = 'PLACED')::int       AS total_pending,
         COALESCE(SUM(b.bet_amount), 0)::numeric                       AS total_staked,
         COALESCE(SUM(b.potential_payout)
           FILTER (WHERE b.result_status = 'WON'), 0)::numeric         AS total_won
       FROM bets b
       WHERE ${where.join(' AND ')}`,
      params.slice(0, -2),
    );
 
    const stats = statsRows[0];
 
    return {
      data: rows.map((r: any) => ({
        betId:           Number(r.bet_id),
        betCode:         r.bet_code,
        betNumber:       r.bet_number,
        betAmount:       parseFloat(r.bet_amount),
        payoutMultiplier: parseFloat(r.payout_multiplier),
        potentialPayout: parseFloat(r.potential_payout),
        actualPayout:    r.actual_payout !== null ? parseFloat(r.actual_payout) : null,
        status:          r.result_status,
        placedAt:        r.placed_at,
        settledAt:       r.settled_at,
        game: {
          id:          Number(r.game_id),
          name:        r.game_name,
          digitLength: Number(r.digit_length),
        },
        round: {
          id:           Number(r.round_id),
          roundCode:    r.round_code,
          drawTime:     r.draw_time,
          status:       r.round_status,
          resultNumber: r.result_number ?? null,
        },
      })),
      page,
      limit,
      total: countRows[0].total,
      totalPages: Math.ceil(countRows[0].total / limit),
      summary: {
        totalBets:    Number(stats.total_bets),
        totalWins:    Number(stats.total_wins),
        totalLosses:  Number(stats.total_losses),
        totalPending: Number(stats.total_pending),
        totalStaked:  parseFloat(stats.total_staked),
        totalWon:     parseFloat(stats.total_won),
        netPL:        parseFloat(stats.total_won) - parseFloat(stats.total_staked),
      },
    };
  }
 
// ═══════════════════════════════════════════════════════════════
// PATCH 1: ADD to game.service.ts — paste before closing }
//
// Two new methods:
//   getAllActiveRounds()     — all open rounds across all games
//   getGamesWithActiveRounds() — games that have at least 1 open round
// ═══════════════════════════════════════════════════════════════
 
  // ═════════════════════════════════════════════════════════════
  // PUBLIC: ALL ACTIVE ROUNDS (across all games)
  //   Shows every OPEN round that hasn't closed yet.
  //   Used by frontend homepage / betting lobby.
  //
  //   GET /games/active-rounds
  //   GET /games/active-rounds?digitLength=3    ← filter by game type
  //   GET /games/active-rounds?gameId=1         ← filter to one game
  // ═════════════════════════════════════════════════════════════
  async getAllActiveRounds(q: {
    digitLength?: number;
    gameId?:      number;
  } = {}) {
    const where: string[] = [
      `gr.status = 'OPEN'`,
      `gr.close_time > NOW()`,
      `g.is_active = TRUE`,
    ];
    const params: any[] = [];
    let i = 1;
 
    if (q.gameId) {
      where.push(`gr.game_id = $${i++}`);
      params.push(q.gameId);
    }
    if (q.digitLength) {
      where.push(`g.digit_length = $${i++}`);
      params.push(q.digitLength);
    }
 
    const rows = await this.dataSource.query(
      `SELECT
         -- Round info
         gr.id                                                        AS round_id,
         gr.round_code,
         gr.open_time,
         gr.close_time,
         gr.draw_time,
         EXTRACT(EPOCH FROM (gr.close_time - NOW()))::int             AS seconds_until_close,
 
         -- Game info (everything frontend needs to render a betting card)
         g.id                                                         AS game_id,
         g.name                                                       AS game_name,
         g.code                                                       AS game_code,
         g.digit_length,
         g.min_bet,
         g.max_bet,
         g.payout_multiplier,
         g.max_payout_per_round,
         g.is_hot,
         g.is_jackpot_badge,
         g.display_category,
         g.thumbnail_url,
 
         -- Live betting stats for this round
         COUNT(b.id)::int                                             AS total_bets,
         COUNT(DISTINCT b.user_id)::int                               AS unique_bettors,
         COALESCE(SUM(b.bet_amount), 0)::numeric                      AS total_staked,
 
         -- Hot numbers for this game (active ones only)
         (
           SELECT json_agg(json_build_object(
             'number', hn.number,
             'note',   hn.note,
             'priority', hn.priority
           ) ORDER BY hn.priority DESC)
           FROM game_hot_numbers hn
           WHERE hn.game_id = g.id AND hn.is_active = TRUE
         ) AS hot_numbers
 
       FROM game_rounds gr
       JOIN games g ON g.id = gr.game_id
       LEFT JOIN bets b
         ON b.round_id = gr.id
        AND b.result_status = 'PLACED'
       WHERE ${where.join(' AND ')}
       GROUP BY gr.id, g.id
       ORDER BY
         g.is_hot DESC,
         g.hot_priority DESC,
         gr.close_time ASC`,
      params,
    );
 
    return rows.map((r: any) => ({
      roundId:          Number(r.round_id),
      roundCode:        r.round_code,
      openTime:         r.open_time,
      closeTime:        r.close_time,
      drawTime:         r.draw_time,
      secondsUntilClose: Number(r.seconds_until_close),
      isClosingSoon:    Number(r.seconds_until_close) <= 300,  // <= 5 min warning
 
      game: {
        id:               Number(r.game_id),
        name:             r.game_name,
        code:             r.game_code,
        digitLength:      Number(r.digit_length),
        minBet:           parseFloat(r.min_bet),
        maxBet:           parseFloat(r.max_bet),
        payoutMultiplier: parseFloat(r.payout_multiplier),
        maxPayoutPerRound: r.max_payout_per_round
          ? parseFloat(r.max_payout_per_round) : null,
        isHot:            r.is_hot,
        isJackpotBadge:   r.is_jackpot_badge,
        displayCategory:  r.display_category,
        thumbnailUrl:     r.thumbnail_url,
      },
 
      liveStats: {
        totalBets:     Number(r.total_bets),
        uniqueBettors: Number(r.unique_bettors),
        totalStaked:   parseFloat(r.total_staked),
      },
 
      hotNumbers: r.hot_numbers ?? [],
    }));
  }
 
  // ═════════════════════════════════════════════════════════════
  // PUBLIC: GAMES WITH ACTIVE ROUNDS ONLY
  //   Same as listGames() but only returns games that currently
  //   have at least one OPEN round. Shows the soonest-closing
  //   round per game.
  //
  //   GET /games/with-active-rounds
  // ═════════════════════════════════════════════════════════════
  async getGamesWithActiveRounds() {
    return this.dataSource.query(
      `SELECT
         g.id, g.code, g.name, g.description, g.thumbnail_url,
         g.digit_length, g.min_bet, g.max_bet, g.payout_multiplier,
         g.max_payout_per_round, g.is_hot, g.is_jackpot_badge,
         g.display_category,
 
         -- Soonest-closing open round
         ar.id              AS active_round_id,
         ar.round_code      AS active_round_code,
         ar.open_time       AS active_round_open,
         ar.close_time      AS active_round_close,
         ar.draw_time       AS active_round_draw,
         EXTRACT(EPOCH FROM (ar.close_time - NOW()))::int AS seconds_until_close,
 
         -- Count of open rounds for this game
         (SELECT COUNT(*)::int FROM game_rounds gr2
          WHERE gr2.game_id = g.id
            AND gr2.status = 'OPEN'
            AND gr2.close_time > NOW()) AS open_rounds_count
 
       FROM games g
       -- Only games that have at least 1 open round
       JOIN LATERAL (
         SELECT id, round_code, open_time, close_time, draw_time
         FROM game_rounds
         WHERE game_id = g.id
           AND status = 'OPEN'
           AND close_time > NOW()
         ORDER BY close_time ASC
         LIMIT 1
       ) ar ON true
       WHERE g.is_active = TRUE
       ORDER BY g.is_hot DESC, g.hot_priority DESC, ar.close_time ASC`,
    );
  }
}
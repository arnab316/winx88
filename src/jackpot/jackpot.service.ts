// src/jackpot/jackpot.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import { TurnoverService } from '../turnover/turnover.service';
import {
  CreateJackpotSessionDto,
  UpdateJackpotSessionDto,
  AdjustJackpotPrizeDto,
  PublishJackpotResultDto,
  AddJackpotHotNumberDto,
  PlaceJackpotBetDto,
  ListJackpotSessionsQueryDto,
  ListJackpotBetsQueryDto,
} from './dto/jackpot.dto';

/**
 * Jackpot Number Game
 *
 * Game types: 6D (pick a 6-digit number) or 7D (pick a 7-digit number).
 *
 * Lifecycle:
 *   DRAFT   → admin edits period, prize, dates
 *   ACTIVE  → betting open; hot numbers visible; admin can still adjust prize
 *   CLOSED  → no new bets; admin must publish result
 *   AWARDED → result published, all bets settled
 *   CANCELLED → no settlement
 *
 * Period types:
 *   WEEKLY  → auto-compute Mon 00:00 UTC → next Mon 00:00 UTC
 *   MONTHLY → auto-compute 1st 00:00 UTC → 1st of next month
 *   CUSTOM  → explicit startsAt / endsAt from admin
 *
 * On activate: a game row (6D_JACKPOT / 7D_JACKPOT) and a game_round are
 * created/linked and their IDs stored in eligibility_rules.
 *
 * On publishResult: all PLACED bets are settled (WON or LOST) exactly like
 * a regular game round, then the pool is marked AWARDED.
 */
@Injectable()
export class JackpotService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly financialLedger: FinancialLedgerService,
    private readonly turnoverService: TurnoverService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  private computePeriodDates(
    periodType: string,
    startsAt?: string,
    endsAt?: string,
  ): { startsAt: Date; endsAt: Date } {
    if (periodType === 'CUSTOM') {
      if (!startsAt || !endsAt) {
        throw new BadRequestException(
          'startsAt and endsAt are required for CUSTOM period',
        );
      }
      const s = new Date(startsAt);
      const e = new Date(endsAt);
      if (e <= s) throw new BadRequestException('endsAt must be after startsAt');
      return { startsAt: s, endsAt: e };
    }

    if (startsAt && endsAt) {
      const s = new Date(startsAt);
      const e = new Date(endsAt);
      if (e <= s) throw new BadRequestException('endsAt must be after startsAt');
      return { startsAt: s, endsAt: e };
    }

    const now = new Date();

    if (periodType === 'WEEKLY') {
      const day = now.getUTCDay(); // 0=Sun … 6=Sat
      const daysFromMon = day === 0 ? 6 : day - 1;
      const monday = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMon),
      );
      const nextMonday = new Date(monday);
      nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
      return { startsAt: monday, endsAt: nextMonday };
    }

    if (periodType === 'MONTHLY') {
      const starts = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const ends = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return { startsAt: starts, endsAt: ends };
    }

    throw new BadRequestException('Invalid periodType');
  }

  // Resolve the backing game code: use the admin-supplied override when given,
  // otherwise derive the default `{digitLength}D_JACKPOT`.
  private gameCodeFor(digitLength: number, override?: string): string {
    const custom = override?.trim();
    if (custom) return custom.toUpperCase();
    return `${digitLength}D_JACKPOT`;
  }

  // Default payout multiplier used when the permanent jackpot game is first
  // seeded (matches the migration: 90× for 6D, 700× for 7D).
  private defaultMultiplierFor(digitLength: number): number {
    return digitLength === 7 ? 700 : 90;
  }

  private roundCodeFor(digitLength: number): string {
    return `JP${digitLength}D-${Date.now()}`;
  }

  private getMeta(pool: any): Record<string, any> {
    return pool.eligibility_rules ?? {};
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: CREATE SESSION (DRAFT)
  // ═══════════════════════════════════════════════════════════════
  async createSession(dto: CreateJackpotSessionDto, adminId: number) {
    const { startsAt, endsAt } = this.computePeriodDates(
      dto.periodType,
      dto.startsAt,
      dto.endsAt,
    );

    // Per-bet stake limits are applied to the backing jackpot game at
    // activation; stash them on the pool meta until then.
    if (
      dto.minBet !== undefined &&
      dto.maxBet !== undefined &&
      dto.maxBet < dto.minBet
    ) {
      throw new BadRequestException('maxBet must be greater than or equal to minBet');
    }

    const meta: Record<string, any> = {
      digitLength: dto.digitLength,
      periodType: dto.periodType,
    };
    if (dto.minBet !== undefined) meta.minBet = dto.minBet;
    if (dto.maxBet !== undefined) meta.maxBet = dto.maxBet;
    // Admin-supplied game code (normalized). Falls back to the derived
    // default at activation if omitted.
    if (dto.gameCode) meta.gameCode = dto.gameCode.trim().toUpperCase();

    const rows = await this.dataSource.query(
      `INSERT INTO jackpot_pools
        (name_en, name_bn, description_en, description_bn, banner_url,
         prize_amount, currency, starts_at, ends_at,
         eligibility_rules, status, created_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'DRAFT',$11)
       RETURNING *`,
      [
        dto.nameEn,
        dto.nameBn ?? null,
        dto.descriptionEn ?? null,
        dto.descriptionBn ?? null,
        dto.bannerUrl ?? null,
        dto.prizeAmount,
        dto.currency ?? 'BDT',
        startsAt.toISOString(),
        endsAt.toISOString(),
        JSON.stringify(meta),
        adminId,
      ],
    );
    return rows[0];
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: UPDATE SESSION (DRAFT only)
  // ═══════════════════════════════════════════════════════════════
  async updateSession(id: number, dto: UpdateJackpotSessionDto) {
    await this.requirePool(id, ['DRAFT']);

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    const map: Record<string, any> = {
      name_en:        dto.nameEn,
      name_bn:        dto.nameBn,
      description_en: dto.descriptionEn,
      description_bn: dto.descriptionBn,
      banner_url:     dto.bannerUrl,
      prize_amount:   dto.prizeAmount,
      starts_at:      dto.startsAt,
      ends_at:        dto.endsAt,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }

    // minBet/maxBet live inside eligibility_rules (jsonb), not their own column.
    // Merge them into the existing meta so they reach the game at activation.
    if (
      dto.minBet !== undefined ||
      dto.maxBet !== undefined ||
      dto.gameCode !== undefined
    ) {
      const cur = await this.dataSource.query(
        `SELECT eligibility_rules FROM jackpot_pools WHERE id = $1`,
        [id],
      );
      const meta = { ...(cur[0]?.eligibility_rules ?? {}) };
      if (dto.minBet !== undefined) meta.minBet = dto.minBet;
      if (dto.maxBet !== undefined) meta.maxBet = dto.maxBet;
      if (dto.gameCode !== undefined)
        meta.gameCode = dto.gameCode.trim().toUpperCase();
      if (
        meta.minBet !== undefined &&
        meta.maxBet !== undefined &&
        meta.maxBet < meta.minBet
      ) {
        throw new BadRequestException('maxBet must be greater than or equal to minBet');
      }
      fields.push(`eligibility_rules = $${i++}::jsonb`);
      values.push(JSON.stringify(meta));
    }

    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(id);

    if (dto.startsAt && dto.endsAt && new Date(dto.endsAt) <= new Date(dto.startsAt)) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    const result = await this.dataSource.query(
      `UPDATE jackpot_pools SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return result[0];
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: ACTIVATE (DRAFT → ACTIVE)
  //   Creates the backing game_round and links it to the pool.
  // ═══════════════════════════════════════════════════════════════
  async activateSession(id: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const poolRows = await qr.query(
        `SELECT * FROM jackpot_pools WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!poolRows.length) throw new NotFoundException('Jackpot session not found');
      const pool = poolRows[0];

      if (pool.status !== 'DRAFT') {
        throw new BadRequestException(
          `Session is ${pool.status}. Only DRAFT sessions can be activated.`,
        );
      }

      const meta = this.getMeta(pool);
      const digitLength: number = meta.digitLength;
      if (!digitLength) throw new BadRequestException('Session has no digitLength in config');

      // Admin-supplied code wins; otherwise fall back to the derived default.
      const gameCode = this.gameCodeFor(digitLength, meta.gameCode);

      // Resolve the permanent jackpot game. It's shared across all sessions of
      // the same digit length. Self-heal: if it doesn't exist (migration not
      // run / row deleted) create it; otherwise apply this session's stake
      // limits if the admin supplied any.
      const gameRows = await qr.query(`SELECT * FROM games WHERE code = $1`, [gameCode]);
      let game: any;
      if (!gameRows.length) {
        const minBet = meta.minBet ?? 10;
        const maxBet = meta.maxBet ?? 50000;
        const ins = await qr.query(
          `INSERT INTO games
             (code, name, digit_length, min_bet, max_bet, payout_multiplier,
              display_category, is_active, result_mode)
           VALUES ($1,$2,$3,$4,$5,$6,'JACKPOT',true,'MANUAL')
           RETURNING *`,
          [
            gameCode,
            `${digitLength}D Jackpot`,
            digitLength,
            minBet,
            maxBet,
            this.defaultMultiplierFor(digitLength),
          ],
        );
        game = ins[0];
      } else {
        game = gameRows[0];
        if (meta.minBet !== undefined || meta.maxBet !== undefined) {
          const upd = await qr.query(
            `UPDATE games
               SET min_bet = COALESCE($1, min_bet),
                   max_bet = COALESCE($2, max_bet),
                   updated_at = NOW()
             WHERE id = $3
             RETURNING *`,
            [meta.minBet ?? null, meta.maxBet ?? null, game.id],
          );
          game = upd[0];
        }
      }

      // Create a dedicated round for this session
      const roundCode = this.roundCodeFor(digitLength);
      const roundRows = await qr.query(
        `INSERT INTO game_rounds
          (game_id, round_code, open_time, close_time, draw_time, status, source)
         VALUES ($1,$2,$3,$4,$4,'OPEN','MANUAL')
         RETURNING *`,
        [game.id, roundCode, pool.starts_at, pool.ends_at],
      );
      const round = roundRows[0];

      // Store gameId and roundId in eligibility_rules
      const updatedMeta = { ...meta, gameId: Number(game.id), roundId: Number(round.id) };

      await qr.query(
        `UPDATE jackpot_pools
         SET status = 'ACTIVE',
             activated_at = NOW(),
             updated_at = NOW(),
             eligibility_rules = $1::jsonb
         WHERE id = $2`,
        [JSON.stringify(updatedMeta), id],
      );

      await qr.commitTransaction();
      return {
        message: 'Session activated — betting is now open',
        sessionId: id,
        gameId: Number(game.id),
        roundId: Number(round.id),
        digitLength,
        openTime: pool.starts_at,
        closeTime: pool.ends_at,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: CLOSE SESSION (ACTIVE → CLOSED)
  //   Stops new bets. Admin must publish result to settle.
  // ═══════════════════════════════════════════════════════════════
  async closeSession(id: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const poolRows = await qr.query(
        `SELECT * FROM jackpot_pools WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!poolRows.length) throw new NotFoundException('Jackpot session not found');
      const pool = poolRows[0];

      if (pool.status !== 'ACTIVE') {
        throw new BadRequestException(
          `Session is ${pool.status}. Only ACTIVE sessions can be closed.`,
        );
      }

      const meta = this.getMeta(pool);

      // Close the underlying game_round so no new bets can be placed
      if (meta.roundId) {
        await qr.query(
          `UPDATE game_rounds SET status = 'CLOSED', updated_at = NOW() WHERE id = $1`,
          [meta.roundId],
        );
      }

      await qr.query(
        `UPDATE jackpot_pools
         SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [id],
      );

      await qr.commitTransaction();
      return { message: 'Session closed — no new bets accepted', sessionId: id };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: CANCEL SESSION
  // ═══════════════════════════════════════════════════════════════
  async cancelSession(id: number, reason: string) {
    const pool = await this.requirePool(id, ['DRAFT', 'ACTIVE', 'CLOSED']);

    const meta = this.getMeta(pool);

    // Cancel any open round
    if (meta.roundId) {
      await this.dataSource.query(
        `UPDATE game_rounds SET status = 'CLOSED', updated_at = NOW()
         WHERE id = $1 AND status = 'OPEN'`,
        [meta.roundId],
      );
      // Mark all PLACED bets as CANCELLED
      await this.dataSource.query(
        `UPDATE bets SET result_status = 'CANCELLED', settled_at = NOW()
         WHERE round_id = $1 AND result_status = 'PLACED'`,
        [meta.roundId],
      );
    }

    await this.dataSource.query(
      `UPDATE jackpot_pools
       SET status = 'CANCELLED', updated_at = NOW(), winner_reason = $1
       WHERE id = $2`,
      [`Cancelled: ${reason}`, id],
    );
    return { message: 'Session cancelled', sessionId: id };
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: ADJUST PRIZE AMOUNT
  // ═══════════════════════════════════════════════════════════════
  async adjustPrize(id: number, dto: AdjustJackpotPrizeDto, adminId: number) {
    if (dto.delta === 0) throw new BadRequestException('delta cannot be zero');

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const rows = await qr.query(
        `SELECT * FROM jackpot_pools WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!rows.length) throw new NotFoundException('Session not found');
      const pool = rows[0];

      if (!['DRAFT', 'ACTIVE'].includes(pool.status)) {
        throw new BadRequestException(`Cannot adjust prize on ${pool.status} session`);
      }

      const before = parseFloat(pool.prize_amount);
      const after = before + dto.delta;
      if (after <= 0) {
        throw new BadRequestException(`Adjustment would set prize to ${after}. Must stay > 0.`);
      }

      await qr.query(
        `UPDATE jackpot_pools SET prize_amount = $1, updated_at = NOW() WHERE id = $2`,
        [after, id],
      );
      await qr.query(
        `INSERT INTO jackpot_pool_adjustments
          (pool_id, amount_before, amount_after, delta, reason, admin_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, before, after, dto.delta, dto.reason, adminId],
      );

      await qr.commitTransaction();
      return { sessionId: id, before, after, delta: dto.delta };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: PUBLISH RESULT (ACTIVE|CLOSED → AWARDED)
  //   Closes betting, records result, settles all bets, awards pool.
  // ═══════════════════════════════════════════════════════════════
  async publishResult(id: number, dto: PublishJackpotResultDto, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const poolRows = await qr.query(
        `SELECT * FROM jackpot_pools WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!poolRows.length) throw new NotFoundException('Session not found');
      const pool = poolRows[0];

      if (!['ACTIVE', 'CLOSED'].includes(pool.status)) {
        throw new BadRequestException(
          `Session must be ACTIVE or CLOSED to publish result. Current: ${pool.status}`,
        );
      }

      const meta = this.getMeta(pool);
      const digitLength: number = meta.digitLength;
      const roundId: number = meta.roundId;

      if (!roundId) {
        throw new BadRequestException(
          'Session has no linked round. Activate the session first.',
        );
      }

      if (dto.resultNumber.length !== digitLength) {
        throw new BadRequestException(
          `Result must be ${digitLength} digits. Got ${dto.resultNumber.length}.`,
        );
      }

      // Prevent duplicate result
      const existing = await qr.query(
        `SELECT id FROM game_results WHERE round_id = $1`,
        [roundId],
      );
      if (existing.length) {
        throw new ConflictException('Result already published for this session');
      }

      const gameId: number = meta.gameId;

      // 1. Insert game result
      await qr.query(
        `INSERT INTO game_results (game_id, round_id, result_number) VALUES ($1,$2,$3)`,
        [gameId, roundId, dto.resultNumber],
      );

      // 2. Close the round for new bets
      await qr.query(
        `UPDATE game_rounds
         SET status = 'RESULT_PUBLISHED', updated_at = NOW()
         WHERE id = $1`,
        [roundId],
      );

      // 3. Settle all PLACED bets
      const bets = await qr.query(
        `SELECT * FROM bets WHERE round_id = $1 AND result_status = 'PLACED'`,
        [roundId],
      );

      let winners = 0;
      let losers = 0;
      let totalPaid = 0;

      for (const bet of bets) {
        const isWin = String(bet.bet_number) === String(dto.resultNumber);
        const betAmount = parseFloat(bet.bet_amount);

        if (isWin) {
          winners++;
          const payout = parseFloat(bet.potential_payout);
          totalPaid += payout;

          const walletRows = await qr.query(
            `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
            [bet.user_id],
          );
          if (!walletRows.length) continue;
          const w = walletRows[0];

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
            description:   `Jackpot ${digitLength}D win — result: ${dto.resultNumber}`,
            createdByType: 'ADMIN',
            createdById:   adminId,
          });

          await qr.query(
            `UPDATE bets SET result_status = 'WON', settled_at = NOW() WHERE id = $1`,
            [bet.id],
          );
        } else {
          losers++;
          await qr.query(
            `UPDATE bets SET result_status = 'LOST', settled_at = NOW() WHERE id = $1`,
            [bet.id],
          );
        }

        // Turnover contribution (same as regular game settlement)
        await this.turnoverService.contributeFromSettledBet(qr, bet.user_id, bet.id, betAmount);
      }

      // 4. Mark round SETTLED
      await qr.query(
        `UPDATE game_rounds SET status = 'SETTLED', updated_at = NOW() WHERE id = $1`,
        [roundId],
      );

      // 5. Expire hot numbers for this game
      await qr.query(
        `UPDATE game_hot_numbers
         SET is_active = false, updated_at = NOW()
         WHERE game_id = $1 AND expires_at <= NOW()`,
        [gameId],
      );

      // 6. Mark pool AWARDED, store result in meta
      const updatedMeta = { ...meta, resultNumber: dto.resultNumber };
      await qr.query(
        `UPDATE jackpot_pools
         SET status = 'AWARDED',
             awarded_at = NOW(),
             closed_at = COALESCE(closed_at, NOW()),
             winner_admin_id = $1,
             winner_reason = $2,
             winner_picked_at = NOW(),
             eligibility_rules = $3::jsonb,
             updated_at = NOW()
         WHERE id = $4`,
        [adminId, `Result: ${dto.resultNumber}`, JSON.stringify(updatedMeta), id],
      );

      await qr.commitTransaction();
      return {
        message: 'Result published and bets settled',
        sessionId: id,
        resultNumber: dto.resultNumber,
        totalBets: bets.length,
        winners,
        losers,
        totalPaid,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: HOT NUMBERS — ADD
  // ═══════════════════════════════════════════════════════════════
  async addHotNumber(id: number, dto: AddJackpotHotNumberDto, adminId: number) {
    const pool = await this.requirePool(id, ['DRAFT', 'ACTIVE', 'CLOSED']);
    const meta = this.getMeta(pool);
    const digitLength: number = meta.digitLength;
    const gameId: number = meta.gameId;

    if (!gameId) {
      throw new BadRequestException(
        'Session must be activated first to link a game for hot numbers',
      );
    }

    if (dto.number.length !== digitLength) {
      throw new BadRequestException(
        `Hot number must be ${digitLength} digits. Got ${dto.number.length}.`,
      );
    }

    const rows = await this.dataSource.query(
      `INSERT INTO game_hot_numbers
        (game_id, number, is_active, priority, note, created_by_admin_id,
         expires_at, updated_at)
       VALUES ($1,$2,true,$3,$4,$5,$6,NOW())
       ON CONFLICT ON CONSTRAINT game_hot_numbers_unique
       DO UPDATE SET
         is_active            = true,
         priority             = EXCLUDED.priority,
         note                 = EXCLUDED.note,
         expires_at           = EXCLUDED.expires_at,
         created_by_admin_id  = EXCLUDED.created_by_admin_id,
         updated_at           = NOW()
       RETURNING *`,
      [
        gameId,
        dto.number,
        dto.priority ?? 0,
        dto.note ?? null,
        adminId,
        pool.ends_at,
      ],
    );
    return rows[0];
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: HOT NUMBERS — REMOVE
  // ═══════════════════════════════════════════════════════════════
  async removeHotNumber(sessionId: number, hotNumberId: number) {
    const pool = await this.requirePool(sessionId, ['DRAFT', 'ACTIVE', 'CLOSED']);
    const meta = this.getMeta(pool);
    const gameId: number = meta.gameId;

    if (!gameId) {
      throw new BadRequestException('Session has no linked game');
    }

    const result = await this.dataSource.query(
      `DELETE FROM game_hot_numbers WHERE id = $1 AND game_id = $2 RETURNING id`,
      [hotNumberId, gameId],
    );
    if (!result.length) throw new NotFoundException('Hot number not found for this session');
    return { message: 'Hot number removed', id: hotNumberId };
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN / USER: HOT NUMBERS — LIST for a session
  // ═══════════════════════════════════════════════════════════════
  async listHotNumbers(sessionId: number) {
    const pool = await this.requirePool(sessionId);
    const meta = this.getMeta(pool);
    const gameId: number = meta.gameId;

    if (!gameId) return [];

    return this.dataSource.query(
      `SELECT id, number, note, priority, is_active, expires_at
       FROM game_hot_numbers
       WHERE game_id = $1
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY priority DESC, id ASC`,
      [gameId],
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: GET STATS for a session
  // ═══════════════════════════════════════════════════════════════
  async getSessionStats(id: number) {
    const pool = await this.requirePool(id);
    const meta = this.getMeta(pool);
    const roundId: number = meta.roundId;

    const base = {
      sessionId: id,
      status: pool.status,
      digitLength: meta.digitLength,
      periodType: meta.periodType,
      prizeAmount: parseFloat(pool.prize_amount),
      startsAt: pool.starts_at,
      endsAt: pool.ends_at,
      resultNumber: meta.resultNumber ?? null,
    };

    if (!roundId) return { ...base, totalBets: 0, uniqueBettors: 0, totalWagered: 0, winners: 0, totalPaid: 0 };

    const [stats] = await this.dataSource.query(
      `SELECT
         COUNT(*)::int                                                         AS total_bets,
         COUNT(DISTINCT user_id)::int                                         AS unique_bettors,
         COALESCE(SUM(bet_amount),0)::numeric                                 AS total_wagered,
         COUNT(CASE WHEN result_status='WON' THEN 1 END)::int                AS winners,
         COALESCE(SUM(CASE WHEN result_status='WON' THEN potential_payout ELSE 0 END),0)::numeric AS total_paid
       FROM bets WHERE round_id = $1`,
      [roundId],
    );

    // Number distribution
    const distribution = await this.dataSource.query(
      `SELECT bet_number, COUNT(*)::int AS bets, COALESCE(SUM(bet_amount),0)::numeric AS wagered
       FROM bets WHERE round_id = $1
       GROUP BY bet_number
       ORDER BY wagered DESC
       LIMIT 20`,
      [roundId],
    );

    return {
      ...base,
      totalBets:    Number(stats.total_bets),
      uniqueBettors: Number(stats.unique_bettors),
      totalWagered:  parseFloat(stats.total_wagered),
      winners:       Number(stats.winners),
      totalPaid:     parseFloat(stats.total_paid),
      topNumbers:    distribution,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: LIST ALL BETS for a session
  // ═══════════════════════════════════════════════════════════════
  async listBets(id: number, q: ListJackpotBetsQueryDto) {
    const pool = await this.requirePool(id);
    const meta = this.getMeta(pool);
    const roundId: number = meta.roundId;

    if (!roundId) return { data: [], page: 1, limit: q.limit ?? 50, total: 0 };

    const where: string[] = [`b.round_id = $1`];
    const params: any[] = [roundId];
    let i = 2;

    if (q.resultStatus) {
      where.push(`b.result_status = $${i++}`);
      params.push(q.resultStatus.toUpperCase());
    }

    const limit = q.limit ?? 50;
    const offset = ((q.page ?? 1) - 1) * limit;
    params.push(limit, offset);

    const data = await this.dataSource.query(
      `SELECT b.id, b.bet_code, b.bet_number, b.bet_amount, b.payout_multiplier,
              b.potential_payout, b.result_status, b.placed_at, b.settled_at,
              u.id AS user_id, u.username, u.full_name
       FROM bets b
       JOIN users u ON u.id = b.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY b.placed_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params,
    );

    const [cnt] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM bets b WHERE ${where.join(' AND ')}`,
      params.slice(0, params.length - 2),
    );

    return { data, page: q.page ?? 1, limit, total: cnt?.total ?? 0 };
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: LIST SESSIONS
  // ═══════════════════════════════════════════════════════════════
  async listSessions(q: ListJackpotSessionsQueryDto) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (q.status) {
      where.push(`p.status = $${i++}`);
      params.push(q.status);
    }
    if (q.digitLength) {
      where.push(`(p.eligibility_rules->>'digitLength')::int = $${i++}`);
      params.push(q.digitLength);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit  = q.limit ?? 20;
    const offset = ((q.page ?? 1) - 1) * limit;

    const data = await this.dataSource.query(
      `SELECT p.*, a.name AS created_by_name
       FROM jackpot_pools p
       LEFT JOIN admin_users a ON a.id = p.created_by_admin_id
       ${whereSql}
       ORDER BY p.starts_at DESC, p.id DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );

    const [cnt] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM jackpot_pools p ${whereSql}`,
      params,
    );

    return { data, page: q.page ?? 1, limit, total: cnt?.total ?? 0 };
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN: GET ONE SESSION (with adjustment history)
  // ═══════════════════════════════════════════════════════════════
  async getSession(id: number) {
    const poolRows = await this.dataSource.query(
      `SELECT p.*, a.name AS created_by_name
       FROM jackpot_pools p
       LEFT JOIN admin_users a ON a.id = p.created_by_admin_id
       WHERE p.id = $1`,
      [id],
    );
    if (!poolRows.length) throw new NotFoundException('Session not found');

    const adjustments = await this.dataSource.query(
      `SELECT id, amount_before, amount_after, delta, reason, admin_id, created_at
       FROM jackpot_pool_adjustments
       WHERE pool_id = $1 ORDER BY created_at ASC`,
      [id],
    );

    const meta = this.getMeta(poolRows[0]);
    let roundInfo = null;
    if (meta.roundId) {
      const [r] = await this.dataSource.query(
        `SELECT id, round_code, status, open_time, close_time, draw_time
         FROM game_rounds WHERE id = $1`,
        [meta.roundId],
      );
      roundInfo = r ?? null;
    }

    return { ...poolRows[0], adjustments, round: roundInfo };
  }

  // ═══════════════════════════════════════════════════════════════
  // USER: PLACE BET
  // ═══════════════════════════════════════════════════════════════
  async placeBet(sessionId: number, userId: number, dto: PlaceJackpotBetDto) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const poolRows = await qr.query(
        `SELECT * FROM jackpot_pools WHERE id = $1`,
        [sessionId],
      );
      if (!poolRows.length) throw new NotFoundException('Jackpot session not found');
      const pool = poolRows[0];

      if (pool.status !== 'ACTIVE') {
        throw new BadRequestException(
          `Betting is not open. Session is ${pool.status}.`,
        );
      }

      const meta = this.getMeta(pool);
      const digitLength: number = meta.digitLength;
      const gameId: number = meta.gameId;
      const roundId: number = meta.roundId;

      if (!roundId || !gameId) {
        throw new BadRequestException('Session is not fully configured. Contact admin.');
      }

      if (dto.betNumber.length !== digitLength) {
        throw new BadRequestException(
          `Bet number must be exactly ${digitLength} digits. Got ${dto.betNumber.length}.`,
        );
      }

      // Verify round is still OPEN
      const [round] = await qr.query(
        `SELECT status, close_time FROM game_rounds WHERE id = $1`,
        [roundId],
      );
      if (!round || round.status !== 'OPEN') {
        throw new BadRequestException('Betting period is closed for this session');
      }
      if (round.close_time && new Date(round.close_time) < new Date()) {
        throw new BadRequestException('Betting period has ended');
      }

      // Load game for bet constraints
      const [game] = await qr.query(`SELECT * FROM games WHERE id = $1`, [gameId]);
      const minBet = parseFloat(game.min_bet ?? '0');
      const maxBet = parseFloat(game.max_bet ?? '0');
      const multiplier = parseFloat(game.payout_multiplier);

      if (minBet && dto.betAmount < minBet) {
        throw new BadRequestException(`Minimum bet is ${minBet}`);
      }
      if (maxBet && dto.betAmount > maxBet) {
        throw new BadRequestException(`Maximum bet is ${maxBet}`);
      }

      // Wallet check
      const [wallet] = await qr.query(
        `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (!wallet) throw new BadRequestException('Wallet not found');

      const balBefore = parseFloat(wallet.balance);
      const bonBefore = parseFloat(wallet.bonus_balance);
      // Bonus is already folded into the main balance, so bets draw from balance.
      if (balBefore < dto.betAmount) {
        throw new BadRequestException('Insufficient balance');
      }

      const balAfter = balBefore - dto.betAmount;
      await qr.query(
        `UPDATE wallets
         SET balance = $1, total_bet = total_bet + $2, updated_at = NOW()
         WHERE id = $3`,
        [balAfter, dto.betAmount, wallet.id],
      );

      const betCode  = `BET-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const potPay   = dto.betAmount * multiplier;

      const [bet] = await qr.query(
        `INSERT INTO bets
          (bet_code, user_id, game_id, round_id, bet_number,
           bet_amount, payout_multiplier, potential_payout, result_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PLACED')
         RETURNING *`,
        [betCode, userId, gameId, roundId, dto.betNumber,
         dto.betAmount, multiplier, potPay],
      );

      // Update number stats
      await qr.query(
        `INSERT INTO game_number_stats (game_id, round_id, bet_number, total_amount, total_bets)
         VALUES ($1,$2,$3,$4,1)
         ON CONFLICT (game_id, round_id, bet_number)
         DO UPDATE SET
           total_amount = game_number_stats.total_amount + $4,
           total_bets   = game_number_stats.total_bets + 1`,
        [gameId, roundId, dto.betNumber, dto.betAmount],
      );

      await this.financialLedger.write({
        qr,
        walletId:      wallet.id,
        userId,
        entryType:     'BET_PLACED',
        flow:          'DEBIT',
        amount:        dto.betAmount,
        balanceBefore: balBefore,
        balanceAfter:  balAfter,
        bonusBefore:   bonBefore,
        bonusAfter:    bonBefore,
        lockedBefore:  parseFloat(wallet.locked_balance),
        lockedAfter:   parseFloat(wallet.locked_balance),
        referenceType: 'BET',
        referenceId:   bet.id,
        status:        'SUCCESS',
        description:   `Jackpot ${digitLength}D bet on ${dto.betNumber}`,
        createdByType: 'USER',
        createdById:   userId,
      });

      await qr.commitTransaction();
      return {
        betCode:         bet.bet_code,
        betNumber:       bet.bet_number,
        betAmount:       parseFloat(bet.bet_amount),
        potentialPayout: potPay,
        newBalance:      balAfter,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // USER: GET ACTIVE SESSIONS (public listing)
  // ═══════════════════════════════════════════════════════════════
  async getActiveSessions(lang: 'en' | 'bn' = 'en') {
    const rows = await this.dataSource.query(
      `SELECT
         p.id,
         p.name_${lang}        AS name,
         p.description_${lang} AS description,
         p.banner_url,
         p.prize_amount,
         p.currency,
         p.starts_at,
         p.ends_at,
         p.status,
         p.eligibility_rules,
         g.code    AS game_code,
         g.min_bet,
         g.max_bet
       FROM jackpot_pools p
       LEFT JOIN games g ON g.id = (p.eligibility_rules->>'gameId')::int
       WHERE p.status = 'ACTIVE'
       ORDER BY p.ends_at ASC`,
    );

    return rows.map((r: any) => {
      const { min_bet, max_bet, game_code, ...rest } = r;
      const meta = r.eligibility_rules ?? {};
      return {
        ...rest,
        // Game code from the linked game row (e.g. "6D_JACKPOT"); if the game
        // row is missing (deleted/re-seeded), derive it from the pool meta.
        gameCode:
          game_code ??
          (meta.digitLength
            ? this.gameCodeFor(meta.digitLength, meta.gameCode)
            : null),
        // Per-bet stake limits come from the linked game row, falling back to
        // the limits stashed on the pool meta at creation.
        minBet: min_bet !== null ? parseFloat(min_bet) : meta.minBet ?? null,
        maxBet: max_bet !== null ? parseFloat(max_bet) : meta.maxBet ?? null,
        digitLength: meta.digitLength,
        periodType:  meta.periodType,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // USER: GET USER'S OWN BETS for a session
  // ═══════════════════════════════════════════════════════════════
  async getUserBets(sessionId: number, userId: number, page = 1, limit = 20) {
    const pool = await this.requirePool(sessionId);
    const meta = this.getMeta(pool);
    const roundId: number = meta.roundId;

    if (!roundId) return { data: [], page, limit, total: 0 };

    const offset = (page - 1) * limit;
    const data = await this.dataSource.query(
      `SELECT id, bet_code, bet_number, bet_amount, payout_multiplier,
              potential_payout, result_status, placed_at, settled_at
       FROM bets
       WHERE round_id = $1 AND user_id = $2
       ORDER BY placed_at DESC
       LIMIT $3 OFFSET $4`,
      [roundId, userId, limit, offset],
    );

    const [cnt] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM bets WHERE round_id = $1 AND user_id = $2`,
      [roundId, userId],
    );

    return { data, page, limit, total: cnt?.total ?? 0 };
  }

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC: PAST AWARDED SESSIONS
  // ═══════════════════════════════════════════════════════════════
  async getPastSessions(limit = 10, lang: 'en' | 'bn' = 'en') {
    return this.dataSource.query(
      `SELECT
         p.id,
         p.name_${lang}  AS name,
         p.prize_amount,
         p.currency,
         p.awarded_at,
         p.eligibility_rules->>'resultNumber'  AS result_number,
         p.eligibility_rules->>'digitLength'   AS digit_length,
         p.eligibility_rules->>'periodType'    AS period_type
       FROM jackpot_pools p
       WHERE p.status = 'AWARDED'
       ORDER BY p.awarded_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE: LOAD + VALIDATE POOL STATUS
  // ═══════════════════════════════════════════════════════════════
  private async requirePool(id: number, allowedStatuses?: string[]) {
    const rows = await this.dataSource.query(
      `SELECT * FROM jackpot_pools WHERE id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Jackpot session not found');
    const pool = rows[0];

    if (allowedStatuses && !allowedStatuses.includes(pool.status)) {
      throw new BadRequestException(
        `Operation not allowed on ${pool.status} session. ` +
        `Allowed statuses: ${allowedStatuses.join(', ')}.`,
      );
    }
    return pool;
  }
}

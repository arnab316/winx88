// src/game/schedule.service.ts
//
// Admin CRUD for game_schedules + the placeBet-with-PDF helper.

import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateScheduleDto, UpdateScheduleDto } from './dto/schedule.dto';
import { BetTicketService } from './bet-ticket.service';
import { GamesGateway } from './games.gateway';

@Injectable()
export class ScheduleService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly betTicketService: BetTicketService,
    private readonly gateway: GamesGateway,
  ) {}

  // ══════════════════════════════════════════════════════════
  // SCHEDULE CRUD
  // ══════════════════════════════════════════════════════════

  // POST /games/admin/:gameId/schedule
  async createSchedule(gameId: number, dto: CreateScheduleDto, adminId: number) {
    const game = await this.dataSource.query(
      `SELECT id, digit_length FROM games WHERE id = $1`,
      [gameId],
    );
    if (!game.length) throw new NotFoundException('Game not found');

    if (dto.betDurationMinutes >= dto.intervalMinutes) {
      throw new BadRequestException(
        `betDurationMinutes (${dto.betDurationMinutes}) must be less than intervalMinutes (${dto.intervalMinutes})`,
      );
    }

    try {
      const rows = await this.dataSource.query(
        `INSERT INTO game_schedules
           (game_id, interval_minutes, bet_duration_minutes, draw_offset_minutes,
            round_code_prefix, next_run_at, is_active, created_by_admin_id)
         VALUES ($1,$2,$3,$4,$5,
                 COALESCE($6::timestamptz, NOW()),
                 COALESCE($7, TRUE),
                 $8)
         RETURNING *`,
        [
          gameId,
          dto.intervalMinutes,
          dto.betDurationMinutes,
          dto.drawOffsetMinutes,
          dto.roundCodePrefix ?? '',
          dto.nextRunAt ?? null,
          dto.isActive ?? true,
          adminId,
        ],
      );
      return rows[0];
    } catch (e: any) {
      if (e.code === '23505') {
        throw new BadRequestException(
          'A schedule already exists for this game. Use PATCH to update it.',
        );
      }
      throw e;
    }
  }

  // PATCH /games/admin/:gameId/schedule
  async updateSchedule(gameId: number, dto: UpdateScheduleDto) {
    const existing = await this.dataSource.query(
      `SELECT * FROM game_schedules WHERE game_id = $1`,
      [gameId],
    );
    if (!existing.length) throw new NotFoundException('No schedule found for this game');

    const sched = existing[0];
    const newInterval = dto.intervalMinutes ?? sched.interval_minutes;
    const newBetDur = dto.betDurationMinutes ?? sched.bet_duration_minutes;

    if (newBetDur >= newInterval) {
      throw new BadRequestException(
        `betDurationMinutes (${newBetDur}) must be less than intervalMinutes (${newInterval})`,
      );
    }

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    const map: Record<string, any> = {
      interval_minutes: dto.intervalMinutes,
      bet_duration_minutes: dto.betDurationMinutes,
      draw_offset_minutes: dto.drawOffsetMinutes,
      round_code_prefix: dto.roundCodePrefix,
      next_run_at: dto.nextRunAt,
      is_active: dto.isActive,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(
          col === 'next_run_at'
            ? `next_run_at = $${i++}::timestamptz`
            : `${col} = $${i++}`,
        );
        values.push(val);
      }
    }

    if (!fields.length) throw new BadRequestException('No fields to update');
    fields.push(`updated_at = NOW()`);
    values.push(gameId);

    const result = await this.dataSource.query(
      `UPDATE game_schedules SET ${fields.join(', ')}
       WHERE game_id = $${i}
       RETURNING *`,
      values,
    );
    return result[0];
  }

  // GET /games/admin/:gameId/schedule
  async getSchedule(gameId: number) {
    const rows = await this.dataSource.query(
      `SELECT
         gs.*,
         g.name    AS game_name,
         g.digit_length,
         (SELECT COUNT(*)::int FROM game_rounds gr
           WHERE gr.game_id = gs.game_id AND gr.source = 'SCHEDULED') AS spawned_count,
         gs.next_run_at AS next_round_opens_at
       FROM game_schedules gs
       JOIN games g ON g.id = gs.game_id
       WHERE gs.game_id = $1`,
      [gameId],
    );
    if (!rows.length) throw new NotFoundException('No schedule found for this game');
    return rows[0];
  }

  // GET /games/admin/scheduler/health
  //   Flags any ACTIVE schedule whose next_run_at is more than one interval
  //   behind NOW — a strong signal the in-process cron has stalled/stopped
  //   (e.g. the API process died). Healthy schedules sit at/ahead of NOW.
  async schedulerHealth() {
    const rows = await this.dataSource.query(
      `SELECT
         gs.id            AS schedule_id,
         gs.game_id,
         g.name           AS game_name,
         gs.is_active,
         gs.interval_minutes,
         gs.next_run_at,
         EXTRACT(EPOCH FROM (NOW() - gs.next_run_at))::int AS seconds_behind
       FROM game_schedules gs
       JOIN games g ON g.id = gs.game_id
       ORDER BY gs.is_active DESC, seconds_behind DESC`,
    );

    const schedules = rows.map((r: any) => {
      const secondsBehind = Number(r.seconds_behind);
      const stale = r.is_active && secondsBehind > r.interval_minutes * 60;
      return {
        scheduleId: Number(r.schedule_id),
        gameId: Number(r.game_id),
        gameName: r.game_name,
        isActive: r.is_active,
        intervalMinutes: r.interval_minutes,
        nextRunAt: r.next_run_at,
        secondsBehind,
        minutesBehind: Math.round(secondsBehind / 60),
        status: !r.is_active ? 'PAUSED' : stale ? 'STALE' : 'OK',
      };
    });

    const stale = schedules.filter((s) => s.status === 'STALE');
    return {
      checkedAt: new Date().toISOString(),
      totalSchedules: schedules.length,
      activeSchedules: schedules.filter((s) => s.isActive).length,
      staleCount: stale.length,
      healthy: stale.length === 0,
      stale, // the problem ones, for quick alerting
      schedules, // full list
    };
  }

  // GET /games/admin/schedules
  async listSchedules() {
    return this.dataSource.query(
      `SELECT
         gs.id, gs.game_id, gs.interval_minutes, gs.bet_duration_minutes,
         gs.draw_offset_minutes, gs.round_code_prefix,
         gs.next_run_at, gs.is_active, gs.created_at, gs.updated_at,
         g.name         AS game_name,
         g.digit_length AS game_digit_length,
         g.is_active    AS game_active,
         (SELECT COUNT(*)::int FROM game_rounds gr
           WHERE gr.game_id = gs.game_id AND gr.source = 'SCHEDULED') AS spawned_count,
         (SELECT COUNT(*)::int FROM game_rounds gr
           WHERE gr.game_id = gs.game_id AND gr.source = 'SCHEDULED'
             AND gr.status = 'OPEN' AND gr.close_time > NOW())         AS active_rounds
       FROM game_schedules gs
       JOIN games g ON g.id = gs.game_id
       ORDER BY gs.is_active DESC, g.digit_length ASC, gs.id ASC`,
    );
  }

  // DELETE /games/admin/:gameId/schedule
  async deleteSchedule(gameId: number) {
    const result = await this.dataSource.query(
      `DELETE FROM game_schedules WHERE game_id = $1 RETURNING id`,
      [gameId],
    );
    if (!result.length) throw new NotFoundException('No schedule found for this game');
    return { message: 'Schedule deleted. Auto-creation stopped for this game.' };
  }

  // POST /games/admin/:gameId/schedule/toggle
  //   Flips is_active. When PAUSING (active -> inactive):
  //     - closeOpenRound = true  (default): force-close any OPEN round now so
  //       the game drops from the live lobby immediately (emits round:closed).
  //     - closeOpenRound = false: leave the current round to finish naturally.
  //   Either way the game is excluded from the lobby (lobby queries are
  //   schedule-aware) and a game:unlisted WS event is emitted.
  //   When RESUMING, emits game:listed; the scheduler spawns the next round.
  async toggleSchedule(gameId: number, closeOpenRound = true) {
    // Toggling always clears any pending graceful pause: resuming obviously
    // cancels it, and a hard pause supersedes it.
    // NOTE: dataSource.query returns [rows, affectedCount] for
    // UPDATE…RETURNING — destructure, or `result[0]` is the rows ARRAY
    // (which made is_active read undefined: the message was always
    // "paused", the pause branch never force-closed, and game:listed was
    // emitted on every toggle regardless of direction).
    const [rows] = await this.dataSource.query(
      `UPDATE game_schedules
       SET is_active = NOT is_active, pause_after_round = FALSE, updated_at = NOW()
       WHERE game_id = $1
       RETURNING *`,
      [gameId],
    );
    if (!rows.length) throw new NotFoundException('No schedule found for this game');
    const sched = rows[0];

    if (sched.is_active === false) {
      // Paused.
      let closedRoundId: number | undefined;

      if (closeOpenRound) {
        const closed = await this.dataSource.query(
          `UPDATE game_rounds
             SET status = 'CLOSED', close_time = NOW()
           WHERE game_id = $1 AND status = 'OPEN'
           RETURNING id, round_code, draw_time`,
          [gameId],
        );
        for (const r of closed) {
          this.gateway.emitRoundClosed({
            gameId,
            roundId: Number(r.id),
            roundCode: r.round_code,
            drawTime: r.draw_time,
          });
        }
        closedRoundId = closed.length ? Number(closed[0].id) : undefined;
      }

      this.gateway.emitGameUnlisted({ gameId, closedRoundId });
    } else {
      // Resumed.
      this.gateway.emitGameListed({ gameId });
    }

    return sched;
  }

  // POST /games/admin/:gameId/schedule/pause-after-round
  //   GRACEFUL pause: the running round finishes normally (players keep
  //   betting until its close_time, the game stays in the lobby), no new
  //   rounds spawn, and once no OPEN round remains the RoundWatcher flips
  //   the schedule to paused and unlists the game.
  //   body { cancel: true } withdraws a pending graceful pause.
  async pauseAfterRound(gameId: number, cancel = false) {
    const scheds = await this.dataSource.query(
      `SELECT id, is_active, pause_after_round FROM game_schedules WHERE game_id = $1`,
      [gameId],
    );
    if (!scheds.length) throw new NotFoundException('No schedule found for this game');
    const sched = scheds[0];

    if (cancel) {
      await this.dataSource.query(
        `UPDATE game_schedules SET pause_after_round = FALSE, updated_at = NOW()
         WHERE game_id = $1`,
        [gameId],
      );
      return {
        message: sched.pause_after_round
          ? 'Pending pause cancelled — the schedule keeps running.'
          : 'No pending pause to cancel.',
        pauseAfterRound: false,
        isActive: sched.is_active,
      };
    }

    if (!sched.is_active) {
      return {
        message: 'Schedule is already paused.',
        pauseAfterRound: false,
        isActive: false,
      };
    }

    const openRounds = await this.dataSource.query(
      `SELECT id, round_code, close_time FROM game_rounds
        WHERE game_id = $1 AND status = 'OPEN'
        ORDER BY close_time ASC`,
      [gameId],
    );

    if (!openRounds.length) {
      // Nothing running — pause right now (identical to a hard pause with
      // nothing to close).
      await this.dataSource.query(
        `UPDATE game_schedules
            SET is_active = FALSE, pause_after_round = FALSE, updated_at = NOW()
          WHERE game_id = $1`,
        [gameId],
      );
      this.gateway.emitGameUnlisted({ gameId });
      return {
        message: 'No round running — schedule paused immediately.',
        pauseAfterRound: false,
        isActive: false,
      };
    }

    await this.dataSource.query(
      `UPDATE game_schedules SET pause_after_round = TRUE, updated_at = NOW()
       WHERE game_id = $1`,
      [gameId],
    );
    return {
      message: `Will pause after the current round closes (${openRounds[0].round_code}).`,
      pauseAfterRound: true,
      isActive: true,
      currentRound: {
        id: Number(openRounds[0].id),
        roundCode: openRounds[0].round_code,
        closeTime: openRounds[0].close_time,
      },
    };
  }

  // ══════════════════════════════════════════════════════════
  // PDF TICKET: generate after placeBet commits
  // ══════════════════════════════════════════════════════════
  async generateBetTicket(bet: any, user: any, game: any, round: any): Promise<string> {
    const ticketData = BetTicketService.formatFromBet(
      {
        id: bet.id,
        bet_code: bet.bet_code,
        bet_number: bet.bet_number,
        bet_amount: bet.bet_amount,
        potential_payout: bet.potential_payout,
        placed_at: bet.placed_at ?? new Date(),
      },
      {
        playerName: user.full_name ?? user.name ?? user.username ?? `User #${user.id}`,
        gameName: game.name,
        digitLength: game.digit_length,
        roundCode: round.round_code,
        baseUrl: process.env.APP_BASE_URL ?? 'https://winx-88.com',
      },
    );

    return this.betTicketService.generate(ticketData);
  }
}
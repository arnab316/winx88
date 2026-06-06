// src/game/round-scheduler.service.ts
//
// Runs every 60 seconds. SPAWNS new rounds from game_schedules.
//
// IMPORTANT: This service does NOT close rounds. Your existing
// RoundWatcherService (round-watcher.service.ts, @Cron EVERY_10_SECONDS)
// already auto-closes OPEN rounds whose close_time passed and emits
// round:closed / round:closing-soon. Do NOT add a second closer — it
// would double-fire WS events.
//
// For each due schedule:
//   1. Re-locks the row (FOR UPDATE SKIP LOCKED) — safe for multi-instance
//   2. Inserts a new game_rounds row (status='OPEN', source='SCHEDULED')
//   3. Advances next_run_at by interval_minutes (NOT from NOW() — no drift)
//   4. Emits WS round:opened after commit
//
// ScheduleModule.forRoot() is already registered in AppModule, so @Cron works.

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { GamesGateway } from './games.gateway';

@Injectable()
export class RoundSchedulerService {
  private readonly logger = new Logger(RoundSchedulerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly gateway: GamesGateway,
  ) {}

  // ── Fires every 60 seconds ──────────────────────────────
  @Cron(CronExpression.EVERY_MINUTE)
  async spawnDueRounds(): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    try {
      // 1. Find active schedules whose next_run_at has arrived.
      const due = await qr.query(
        `SELECT
           gs.id              AS schedule_id,
           gs.game_id,
           gs.interval_minutes,
           gs.bet_duration_minutes,
           gs.draw_offset_minutes,
           gs.round_code_prefix,
           gs.next_run_at,
           g.name             AS game_name,
           g.is_active        AS game_active
         FROM game_schedules gs
         JOIN games g ON g.id = gs.game_id
         WHERE gs.is_active = TRUE
           AND gs.next_run_at <= NOW()
         ORDER BY gs.next_run_at ASC
         LIMIT 50`,
      );

      if (!due.length) return;

      this.logger.log(`Scheduler: ${due.length} schedule(s) due`);

      for (const sched of due) {
        if (!sched.game_active) {
          this.logger.warn(
            `Skipping schedule ${sched.schedule_id} — game ${sched.game_id} is inactive`,
          );
          // Still advance next_run_at so we don't keep re-checking it.
          await this.advanceNextRun(
            qr,
            sched.schedule_id,
            sched.interval_minutes,
            sched.next_run_at,
          );
          continue;
        }

        await this.spawnRound(qr, sched);
      }
    } catch (err) {
      this.logger.error('Scheduler top-level error', err as any);
    } finally {
      await qr.release();
    }
  }

  // ── Spawn a single round in its own short transaction ────
  private async spawnRound(qr: any, sched: any): Promise<void> {
    await qr.startTransaction();
    try {
      // 2. Re-lock the schedule row — SKIP LOCKED means if another
      //    instance grabbed it, we move on safely.
      const locked = await qr.query(
        `SELECT id FROM game_schedules
         WHERE id = $1 AND is_active = TRUE AND next_run_at <= NOW()
         FOR UPDATE SKIP LOCKED`,
        [sched.schedule_id],
      );
      if (!locked.length) {
        await qr.rollbackTransaction();
        return;
      }

      // 3. Compute the round's open time.
      //    Normally openTime === next_run_at. But after downtime next_run_at
      //    can be far in the past, which would spawn an already-closed round
      //    (and, advancing one interval per tick, keep doing so for minutes).
      //    Detect that and realign to the grid slot that covers "now".
      const nowRows = await qr.query(`SELECT NOW() AS now`);
      const now = new Date(nowRows[0].now).getTime();
      const intervalMs = sched.interval_minutes * 60_000;
      const betMs = sched.bet_duration_minutes * 60_000;

      let openMs = new Date(sched.next_run_at).getTime();

      if (openMs + betMs <= now) {
        // This slot's round would already be closed → stale (downtime catch-up).
        // Smallest k such that the realigned slot's close_time is still in the future.
        const k = Math.ceil((now - betMs - openMs) / intervalMs);
        const realignedMs = openMs + k * intervalMs;

        if (realignedMs > now) {
          // "now" falls in a dead gap between rounds (bet window already passed,
          // next slot not started). Don't spawn a future round early — just
          // realign next_run_at and let the normal tick fire it on time.
          await qr.query(
            `UPDATE game_schedules
               SET next_run_at = $1::timestamptz, updated_at = NOW()
             WHERE id = $2`,
            [new Date(realignedMs).toISOString(), sched.schedule_id],
          );
          await qr.commitTransaction();
          this.logger.warn(
            `Schedule ${sched.schedule_id} (game ${sched.game_id}): realigned ` +
              `${k} stale interval(s) after downtime; next round at ` +
              `${new Date(realignedMs).toISOString()}`,
          );
          return;
        }

        // "now" is inside the realigned slot's betting window → spawn it live.
        this.logger.warn(
          `Schedule ${sched.schedule_id} (game ${sched.game_id}): skipped ` +
            `${k} stale interval(s) after downtime`,
        );
        openMs = realignedMs;
      }

      const openTime = new Date(openMs);
      const closeTime = new Date(openMs + betMs);
      const drawTime = new Date(
        closeTime.getTime() + sched.draw_offset_minutes * 60_000,
      );

      // Round code: PREFIX-YYYYMMDD-HHmmss (based on draw_time)
      const dtStr = this.formatRoundCodeDate(drawTime);
      const roundCode = sched.round_code_prefix
        ? `${sched.round_code_prefix}-${dtStr}`
        : dtStr;

      // 4. Guard against accidental duplicate round code
      const dup = await qr.query(
        `SELECT id FROM game_rounds WHERE game_id = $1 AND round_code = $2`,
        [sched.game_id, roundCode],
      );
      if (dup.length) {
        this.logger.warn(
          `Duplicate round code ${roundCode} for game ${sched.game_id} — skipping insert`,
        );
        await this.advanceNextRunInTx(
          qr,
          sched.schedule_id,
          sched.interval_minutes,
          openTime.toISOString(),
        );
        await qr.commitTransaction();
        return;
      }

      // 5. Insert round
      const rows = await qr.query(
        `INSERT INTO game_rounds
           (game_id, round_code, open_time, close_time, draw_time, status, source)
         VALUES ($1, $2, $3, $4, $5, 'OPEN', 'SCHEDULED')
         RETURNING *`,
        [sched.game_id, roundCode, openTime, closeTime, drawTime],
      );
      const round = rows[0];

      // 6. Advance next_run_at from this round's openTime (NOT NOW() — prevents
      //    drift; openTime may have been realigned above after downtime).
      await this.advanceNextRunInTx(
        qr,
        sched.schedule_id,
        sched.interval_minutes,
        openTime.toISOString(),
      );

      await qr.commitTransaction();

      // 7. Emit WS event AFTER commit — matches GamesGateway.emitRoundOpened
      this.gateway.emitRoundOpened({
        gameId: Number(round.game_id),
        roundId: Number(round.id),
        roundCode: round.round_code,
        openTime: round.open_time,
        closeTime: round.close_time,
        drawTime: round.draw_time,
      });

      this.logger.log(
        `Spawned round ${roundCode} for game ${sched.game_id} (${sched.game_name})`,
      );
    } catch (err) {
      await qr.rollbackTransaction();
      this.logger.error(
        `Failed to spawn round for schedule ${sched.schedule_id} / game ${sched.game_id}`,
        err as any,
      );
    }
  }

  // ── advance next_run_at (outside transaction — for skipped games) ──
  private async advanceNextRun(
    qr: any,
    scheduleId: number,
    intervalMinutes: number,
    currentNextRun: Date | string,
  ): Promise<void> {
    await qr.query(
      `UPDATE game_schedules
       SET next_run_at = $1::timestamptz + ($2 || ' minutes')::interval,
           updated_at  = NOW()
       WHERE id = $3`,
      [currentNextRun, intervalMinutes, scheduleId],
    );
  }

  // ── advance next_run_at (inside existing transaction) ────
  private async advanceNextRunInTx(
    qr: any,
    scheduleId: number,
    intervalMinutes: number,
    currentNextRun: Date | string,
  ): Promise<void> {
    await qr.query(
      `UPDATE game_schedules
       SET next_run_at = $1::timestamptz + ($2 || ' minutes')::interval,
           updated_at  = NOW()
       WHERE id = $3`,
      [currentNextRun, intervalMinutes, scheduleId],
    );
  }

  // ── Format date as "20250521-143000" for round codes (UTC) ─
  private formatRoundCodeDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
    );
  }
}
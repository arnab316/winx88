// src/game/round-watcher.service.ts
//
// Server-side timer that drives 'round:closing-soon' and 'round:closed'
// WebSocket events.
//
// Runs every 10 seconds. For each OPEN round:
//   - If closing in <= 30 seconds AND we haven't warned yet → emit 'closing-soon'
//   - If close_time has passed → flip status to CLOSED + emit 'closed'
//
// Uses an in-memory Set to track which rounds we've already warned about
// so we don't spam the same event every 10s. The Set is cleared when the
// round transitions out of OPEN status.
//
// SCALING NOTE:
//   On a single Node instance this is fine. If you scale to multiple
//   instances, two will both try to flip status to CLOSED — the UPDATE
//   uses `WHERE status = 'OPEN'` so only one wins, but you'd get duplicate
//   WS events. Add a Redis lock then, or accept the small duplication.

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { GamesGateway } from './games.gateway';

@Injectable()
export class RoundWatcherService {
  private readonly logger = new Logger(RoundWatcherService.name);

  // Tracks rounds we've already warned about (closing-soon)
  private warnedRounds = new Set<number>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly gateway: GamesGateway,
  ) {}

  // Every 10 seconds. Aggressive enough to catch close_time within ~10s.
  // Adjust to EVERY_5_SECONDS if your rounds are short-lived (< 1 min).
  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick() {
    try {
      // 1. Auto-close any OPEN rounds whose close_time has passed
      const closed = await this.dataSource.query(
        `UPDATE game_rounds
         SET status = 'CLOSED'
         WHERE status = 'OPEN' AND close_time <= NOW()
         RETURNING id, game_id, close_time`,
      );

      for (const r of closed) {
        this.gateway.emitRoundClosed({
          gameId: Number(r.game_id),
          roundId: Number(r.id),
          closeTime: r.close_time,
        });
        this.warnedRounds.delete(Number(r.id));
        this.logger.log(`Auto-closed round ${r.id} (game ${r.game_id})`);
      }

      // 2. Find OPEN rounds closing in next 30 seconds we haven't warned yet
      const closing = await this.dataSource.query(
        `SELECT id, game_id,
                EXTRACT(EPOCH FROM (close_time - NOW()))::int AS seconds_until_close
         FROM game_rounds
         WHERE status = 'OPEN'
           AND close_time > NOW()
           AND close_time <= NOW() + INTERVAL '30 seconds'`,
      );

      for (const r of closing) {
        const id = Number(r.id);
        if (this.warnedRounds.has(id)) continue;

        this.gateway.emitRoundClosingSoon({
          gameId: Number(r.game_id),
          roundId: id,
          secondsUntilClose: Number(r.seconds_until_close),
        });
        this.warnedRounds.add(id);
      }

      // 3. Cleanup memory: remove warned-IDs that are no longer OPEN
      //    (covers admins manually closing rounds early)
      if (this.warnedRounds.size > 0) {
        const ids = [...this.warnedRounds];
        const stillOpen = await this.dataSource.query(
          `SELECT id FROM game_rounds
           WHERE id = ANY($1::bigint[]) AND status = 'OPEN'`,
          [ids],
        );
        const stillOpenSet = new Set(stillOpen.map((r: any) => Number(r.id)));
        for (const id of ids) {
          if (!stillOpenSet.has(id)) this.warnedRounds.delete(id);
        }
      }
    } catch (e: any) {
      this.logger.error(`tick failed: ${e.message}`);
    }
  }
}
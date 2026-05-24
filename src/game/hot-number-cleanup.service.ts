// src/game/hot-number-cleanup.service.ts
//
// Runs every hour. Deletes game_hot_numbers rows where expires_at has passed.
// Hot numbers are created with expires_at = NOW() + 24h.
// This cron is the actual deletion mechanism.
//
// ScheduleModule.forRoot() is already in AppModule — @Cron works immediately.

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { GamesGateway } from './games.gateway';

@Injectable()
export class HotNumberCleanupService {
  private readonly logger = new Logger(HotNumberCleanupService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly gateway: GamesGateway,
  ) {}

  // Runs every hour — light query, index on expires_at keeps it fast
  @Cron(CronExpression.EVERY_HOUR)
  async deleteExpiredHotNumbers(): Promise<void> {
    try {
      const deleted = await this.dataSource.query(
        `DELETE FROM game_hot_numbers
         WHERE expires_at IS NOT NULL
           AND expires_at <= NOW()
         RETURNING id, game_id, number`,
      );

      if (deleted.length) {
        this.logger.log(
          `Cleaned up ${deleted.length} expired hot number(s): ` +
          deleted.map((r: any) => `#${r.id} (game ${r.game_id}: ${r.number})`).join(', '),
        );
        // Emit per game so frontend hides expired numbers
        const byGame: Record<number, any[]> = {};
        for (const r of deleted) {
          (byGame[r.game_id] ??= []).push({ id: Number(r.id), number: r.number });
        }
        for (const [gameId, hotNumbers] of Object.entries(byGame)) {
          this.gateway.emitHotNumbersUpdated({
            gameId: Number(gameId),
            action: 'expired',
            hotNumbers,
          });
        }
      }
    } catch (err) {
      this.logger.error('HotNumberCleanupService error', err as any);
    }
  }
}
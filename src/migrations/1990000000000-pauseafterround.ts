import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Graceful schedule pause: "pause AFTER the current round finishes".
 *
 * game_schedules.pause_after_round — when TRUE the scheduler spawns no new
 * rounds, the game stays in the lobby and the running round completes
 * normally; once no OPEN round remains, the RoundWatcher flips the schedule
 * to is_active = FALSE (the real pause) and clears this flag.
 *
 * Distinct from the existing hard pause (toggle → is_active = FALSE), which
 * unlists the game immediately and by default force-closes the live round.
 */
export class PauseAfterRound1990000000000 implements MigrationInterface {
  name = 'PauseAfterRound1990000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.game_schedules
        ADD COLUMN IF NOT EXISTS pause_after_round BOOLEAN NOT NULL DEFAULT FALSE;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.game_schedules DROP COLUMN IF EXISTS pause_after_round;
    `);
  }
}

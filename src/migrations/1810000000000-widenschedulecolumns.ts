import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * game_schedules.interval_minutes / bet_duration_minutes / draw_offset_minutes
 * were SMALLINT (max 32767 ≈ 22.7 days). Long-cycle games (7D = 30-day round =
 * 43200 min) overflow that. Widen them to INTEGER.
 */
export class WidenScheduleColumns1810000000000 implements MigrationInterface {
  name = 'WidenScheduleColumns1810000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.game_schedules
        ALTER COLUMN interval_minutes     TYPE INTEGER,
        ALTER COLUMN bet_duration_minutes TYPE INTEGER,
        ALTER COLUMN draw_offset_minutes  TYPE INTEGER;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.game_schedules
        ALTER COLUMN interval_minutes     TYPE SMALLINT,
        ALTER COLUMN bet_duration_minutes TYPE SMALLINT,
        ALTER COLUMN draw_offset_minutes  TYPE SMALLINT;
    `);
  }
}

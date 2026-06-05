import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes supporting the paginated admin round-list endpoints.
 *
 * 1. result-declared (GET /games/admin/rounds/result-declared) drives off
 *    `ORDER BY game_results.created_at DESC LIMIT/OFFSET` → descending index
 *    lets Postgres satisfy ORDER BY + LIMIT via an index scan instead of
 *    sorting the whole table per page.
 *
 * 2. awaiting-result (GET /games/admin/rounds/awaiting-result) selects
 *    `status = 'CLOSED'` ordered by `draw_time ASC` → a partial index on
 *    draw_time (only CLOSED rounds) keeps the working set small and
 *    pre-sorted for the LIMIT/OFFSET.
 */
export class GameResultsCreatedAtIndex1780100000003 implements MigrationInterface {
  name = 'GameResultsCreatedAtIndex1780100000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_game_results_created_at
        ON public.game_results (created_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_game_rounds_closed_draw_time
        ON public.game_rounds (draw_time ASC)
        WHERE status = 'CLOSED';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_game_rounds_closed_draw_time;`);
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_game_results_created_at;`);
  }
}

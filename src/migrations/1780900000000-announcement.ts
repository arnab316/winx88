import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marquee announcements — a single line of admin-set text shown in the
 * frontend scrolling banner.
 */
export class Announcement1780900000000 implements MigrationInterface {
  name = 'Announcement1780900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.announcements (
        id         SERIAL       PRIMARY KEY,
        message    TEXT         NOT NULL,
        is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP    NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP    NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_announcements_active
        ON public.announcements(is_active);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_announcements_active;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.announcements;`);
  }
}

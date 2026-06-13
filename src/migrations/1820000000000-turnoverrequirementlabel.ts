import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manual-adjustment and default-deposit turnover requirements carry a
 * human-readable label (e.g. "Weekly Loss Bonus") that the user's wagering
 * page renders as the requirement's header. Add a nullable label column.
 */
export class TurnoverRequirementLabel1820000000000
  implements MigrationInterface
{
  name = 'TurnoverRequirementLabel1820000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.turnover_requirements
        ADD COLUMN IF NOT EXISTS label VARCHAR(255);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.turnover_requirements
        DROP COLUMN IF EXISTS label;
    `);
  }
}

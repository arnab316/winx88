import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds provider tracking to Palace slot history.
 *
 *  - slot_transactions.provider_id : the Palace provider that produced the
 *    transaction (sent on every bet/win/cancel callback).
 *  - palace_providers              : id -> name lookup, self-populated whenever
 *    GET /slot/providers is called, so history can show "JILI" instead of a bare id.
 */
export class SlotProviderHistory1780200000000 implements MigrationInterface {
  name = 'SlotProviderHistory1780200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.slot_transactions
        ADD COLUMN IF NOT EXISTS provider_id INTEGER;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_slot_tx_provider
        ON public.slot_transactions(provider_id);
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.palace_providers (
        provider_id INTEGER      PRIMARY KEY,
        name        VARCHAR(120) NOT NULL,
        updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_slot_tx_provider;`);
    await queryRunner.query(`ALTER TABLE public.slot_transactions DROP COLUMN IF EXISTS provider_id;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.palace_providers;`);
  }
}

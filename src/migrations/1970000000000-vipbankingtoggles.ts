import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-VIP-group banking toggles ("10 toggle buttons" spec):
 *
 *  - vip_level_config.deposit_enabled / withdrawal_enabled — the two master
 *    switches that turn ALL deposits / withdrawals off for a tier.
 *  - tier_banks.deposit_enabled / withdrawal_enabled — one pair per payment
 *    channel (bKash, Nagad, Rocket, Upay = 8 toggles), keyed by gateway NAME
 *    so duplicate gateway rows of the same brand are toggled together.
 *
 * Every existing tier is seeded with a row per current gateway name
 * (WinyPay excluded — it is the automated PSP, not a member-facing channel),
 * everything defaulting to enabled so nothing changes until an admin flips
 * a toggle. A missing tier_banks row is treated as enabled by the runtime
 * gate, so future gateways/tiers stay open by default too.
 */
export class VipBankingToggles1970000000000 implements MigrationInterface {
  name = 'VipBankingToggles1970000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.vip_level_config
        ADD COLUMN IF NOT EXISTS deposit_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS withdrawal_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await queryRunner.query(`
      ALTER TABLE public.tier_banks
        ADD COLUMN IF NOT EXISTS deposit_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS withdrawal_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    // Seed one channel row per (tier × gateway name), default all-enabled.
    await queryRunner.query(`
      INSERT INTO public.tier_banks (level, channel, enabled, deposit_enabled, withdrawal_enabled)
      SELECT vlc.level, g.name, TRUE, TRUE, TRUE
        FROM public.vip_level_config vlc
        CROSS JOIN (
          SELECT DISTINCT name FROM public.payment_gateways
           WHERE LOWER(name) <> 'winypay'
        ) g
      ON CONFLICT (level, channel) DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.tier_banks
        DROP COLUMN IF EXISTS deposit_enabled,
        DROP COLUMN IF EXISTS withdrawal_enabled;
    `);
    await queryRunner.query(`
      ALTER TABLE public.vip_level_config
        DROP COLUMN IF EXISTS deposit_enabled,
        DROP COLUMN IF EXISTS withdrawal_enabled;
    `);
  }
}

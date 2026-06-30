import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WinyPay (Bangladesh PSP) DEPOSIT integration — automated online deposits that
 * coexist with the existing manual agent deposits. Withdrawals are unchanged.
 *
 * Adds provider-tracking columns to `deposits` (the same table the manual flow
 * uses, so admin lists / history / turnover / referral hooks all keep working)
 * and registers a WinyPay row in `payment_gateways` with type ONLINE so the
 * frontend knows to use the pay_url flow instead of screenshot + agent number.
 * Idempotent.
 */
export class WinyPayDeposit1920000000000 implements MigrationInterface {
  name = 'WinyPayDeposit1920000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.deposits
        ADD COLUMN IF NOT EXISTS provider        VARCHAR(30),   -- e.g. 'WINYPAY'; NULL = manual agent deposit
        ADD COLUMN IF NOT EXISTS provider_txn_id VARCHAR(120),  -- WinyPay internal_txn_id / transaction_id
        ADD COLUMN IF NOT EXISTS pay_type        VARCHAR(20),   -- bkash | nagad
        ADD COLUMN IF NOT EXISTS pay_url         TEXT;          -- WinyPay-hosted payment URL
    `);
    // Fast lookups: callbacks match by deposit_code (= our order_id); also index provider txn.
    await q.query(`CREATE INDEX IF NOT EXISTS idx_deposits_provider_txn ON public.deposits (provider_txn_id);`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_deposits_deposit_code ON public.deposits (deposit_code);`);

    // Allow the new 'ONLINE' gateway type (existing check only permits
    // MOBILE_BANKING / BANK / CRYPTO).
    await q.query(`ALTER TABLE public.payment_gateways DROP CONSTRAINT IF EXISTS payment_gateways_type_check;`);
    await q.query(`
      ALTER TABLE public.payment_gateways
        ADD CONSTRAINT payment_gateways_type_check
        CHECK (type IN ('MOBILE_BANKING','BANK','CRYPTO','ONLINE'));
    `);

    // The payment_gateways id sequence can lag behind MAX(id) (e.g. after a
    // dump/restore that inserted rows with explicit ids), which makes a plain
    // INSERT collide on the pkey ("duplicate key ... id already exists").
    // Re-sync the sequence to MAX(id) first so the next id is MAX+1.
    await q.query(`
      SELECT setval(
        pg_get_serial_sequence('public.payment_gateways', 'id'),
        COALESCE((SELECT MAX(id) FROM public.payment_gateways), 1),
        (SELECT EXISTS (SELECT 1 FROM public.payment_gateways))
      );
    `);

    // Register WinyPay as an ONLINE gateway (so it appears as a deposit method).
    await q.query(`
      INSERT INTO public.payment_gateways (name, type, account_no, is_active, created_at)
      SELECT 'WinyPay', 'ONLINE', NULL, TRUE, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.payment_gateways WHERE name = 'WinyPay' AND type = 'ONLINE'
      );
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM public.payment_gateways WHERE name = 'WinyPay' AND type = 'ONLINE';`);
    // Restore the original type check (without ONLINE).
    await q.query(`ALTER TABLE public.payment_gateways DROP CONSTRAINT IF EXISTS payment_gateways_type_check;`);
    await q.query(`
      ALTER TABLE public.payment_gateways
        ADD CONSTRAINT payment_gateways_type_check
        CHECK (type IN ('MOBILE_BANKING','BANK','CRYPTO'));
    `);
    await q.query(`DROP INDEX IF EXISTS idx_deposits_provider_txn;`);
    await q.query(`DROP INDEX IF EXISTS idx_deposits_deposit_code;`);
    await q.query(`
      ALTER TABLE public.deposits
        DROP COLUMN IF EXISTS provider,
        DROP COLUMN IF EXISTS provider_txn_id,
        DROP COLUMN IF EXISTS pay_type,
        DROP COLUMN IF EXISTS pay_url;
    `);
  }
}

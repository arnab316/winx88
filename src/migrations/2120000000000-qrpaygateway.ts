import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seed the 'QR Pay' payment gateway.
 *
 * type = MOBILE_BANKING, not a new value: the player pays from a mobile
 * banking app, and the CHECK constraint only permits
 * MOBILE_BANKING / BANK / CRYPTO / ONLINE. It deliberately stays out of
 * ONLINE, which is WinyPay's automated-PSP lane — WinyPayService looks its own
 * gateway up by name + type = 'ONLINE'.
 *
 * QR Pay is a MANUAL flow: the player scans, pays, then submits a transaction
 * reference and screenshot for admin approval, exactly like an agent deposit.
 *
 * Guarded on name, so re-running it — or running it against an environment
 * where the row was already created by hand — is a no-op.
 */
export class QrPayGateway2120000000000 implements MigrationInterface {
  name = 'QrPayGateway2120000000000';

  public async up(q: QueryRunner): Promise<void> {
    // The id sequence can lag behind MAX(id) after a dump/restore that
    // inserted rows with explicit ids, which makes a plain INSERT collide on
    // the pkey. Re-sync first — same guard the WinyPay migration needed on
    // this exact table.
    await q.query(`
      SELECT setval(
        pg_get_serial_sequence('public.payment_gateways', 'id'),
        COALESCE((SELECT MAX(id) FROM public.payment_gateways), 1),
        (SELECT EXISTS (SELECT 1 FROM public.payment_gateways))
      );
    `);

    await q.query(`
      INSERT INTO public.payment_gateways (name, type, account_no, is_active, created_at)
      SELECT 'QR Pay', 'MOBILE_BANKING', NULL, TRUE, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.payment_gateways WHERE name = 'QR Pay'
      );
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Only removes the gateway if nothing depends on it. Agents and deposits
    // reference it, and dropping a gateway that has taken money would orphan
    // real financial history.
    await q.query(`
      DELETE FROM public.payment_gateways g
       WHERE g.name = 'QR Pay'
         AND NOT EXISTS (SELECT 1 FROM public.agents   a WHERE a.gateway_id = g.id)
         AND NOT EXISTS (SELECT 1 FROM public.deposits d WHERE d.gateway_id = g.id);
    `);
  }
}

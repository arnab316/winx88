import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * QR Pay deposits.
 *
 * A QR destination is just another agent: same rotation, same
 * GET /agents/deposit-agent call, same deposit submission with agent_id. The
 * only difference is what the player is shown — a scannable merchant QR poster
 * instead of a wallet number to type into their banking app.
 *
 * Modelling it as an agent rather than a parallel flow means the deposit gate,
 * VIP banking toggles, admin approval, promotions, turnover and the Meta
 * conversion all keep working untouched.
 *
 * `qr_image_url` NULL = an ordinary wallet agent, which is every existing row.
 * agents.wallet_type carries 'QR' for these, and agent_number still holds the
 * merchant account so the column's NOT NULL/format rules are satisfied and
 * admins can reconcile against a bank statement.
 */
export class AgentQrImage2100000000000 implements MigrationInterface {
  name = 'AgentQrImage2100000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.agents
        ADD COLUMN IF NOT EXISTS qr_image_url VARCHAR(500);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.agents DROP COLUMN IF EXISTS qr_image_url;
    `);
  }
}

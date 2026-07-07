import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Business rule change (2026-07-07): the referrer's deposit minimum for a
 * refer-a-friend bonus counts their LIFETIME approved deposits, not only the
 * deposits made after each referee signed up. The counter no longer restarts
 * per referral.
 *
 * Code side: attachReferralOnSignup() now seeds referrer_deposit_total with
 * the referrer's lifetime approved-deposit sum at row creation.
 *
 * This migration backfills the rows that already exist: every open
 * (PENDING/ACTIVE) referral gets its referrer_deposit_total raised to the
 * referrer's lifetime total, and referrer_deposit_met recomputed. Decided
 * rows (DONE/EXPIRED/DISQUALIFIED/...) are left untouched — history stays as
 * it was decided under the old rule.
 *
 * NOTE: this migration does NOT credit bonuses. Rows that become fully
 * qualified here have no deposit/bet event to trigger the engine, so run
 *   POST /referral/admin/recompute        (all open rows)
 * after deploying — it runs the real completion path (fraud gate, wallet
 * credit, ledger, wagering record) for every open row whose targets are met.
 *
 * Idempotent: GREATEST() + recomputed flags converge on re-run.
 */
export class ReferrerLifetimeDeposit1950000000000 implements MigrationInterface {
  name = 'ReferrerLifetimeDeposit1950000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE friend_referrals fr
         SET referrer_deposit_total = GREATEST(fr.referrer_deposit_total, d.lifetime_total),
             referrer_deposit_met   = (fr.config_referrer_dep_min <= 0
                                       OR GREATEST(fr.referrer_deposit_total, d.lifetime_total)
                                          >= fr.config_referrer_dep_min),
             updated_at             = NOW()
        FROM (
          SELECT user_id, COALESCE(SUM(amount), 0) AS lifetime_total
            FROM deposits
           WHERE status = 'APPROVED'
           GROUP BY user_id
        ) d
       WHERE d.user_id = fr.referrer_user_id
         AND fr.status IN ('PENDING', 'ACTIVE');
    `);
  }

  public async down(_q: QueryRunner): Promise<void> {
    // Irreversible by design: the old per-referral totals are overwritten and
    // cannot be reconstructed (they were "deposits since started_at", which
    // GREATEST() folded into the lifetime figure). Rows decided after the
    // backfill stay decided. No-op.
  }
}

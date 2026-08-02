import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SIGNUP DOMAIN — which of our sites a player registered on.
 *
 * The admin member list shows a "Channel Type / Channel Name" pair describing
 * where each player came from. Three of the four types can already be derived
 * from existing data:
 *
 *   Affiliate       referrals            → the affiliate's username
 *   Refer A Friend  friend_referrals     → the referrer's username
 *   Marketing       user_channel_attribution → the campaign code
 *   Direct          ← nothing recorded it
 *
 * "Direct" is the gap this closes. We run more than one public domain
 * (winx-88.com and winx88.net), and for an unattributed signup the useful
 * answer to "where did they come from" is which site they used.
 *
 * Captured from the browser's Origin header at registration (falling back to
 * Referer), so no frontend change is required — a cross-origin POST to the API
 * always carries it. Stored as the bare host, e.g. `winx88.net`.
 *
 * NULL means "registered before this shipped", which is every existing row and
 * is not recoverable — there is no backfill for a header nobody stored.
 * The member list renders that as Direct with no name rather than guessing.
 *
 * Idempotent.
 */
export class SignupDomain2060000000000 implements MigrationInterface {
  name = 'SignupDomain2060000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.users
        ADD COLUMN IF NOT EXISTS signup_domain VARCHAR(120);
    `);

    // Supports "break down signups by domain" reporting; partial because the
    // column is NULL for every pre-existing row and always will be.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_users_signup_domain
        ON public.users (signup_domain)
        WHERE signup_domain IS NOT NULL;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_users_signup_domain;`);
    await q.query(`ALTER TABLE public.users DROP COLUMN IF EXISTS signup_domain;`);
  }
}

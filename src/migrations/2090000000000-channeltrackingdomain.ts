import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-channel tracking domain.
 *
 * The brand runs on more than one domain (winx-88.com, winx88.net, …) and a
 * media buyer's creatives are approved against ONE of them — a Facebook ad
 * reviewed for winx88.net cannot start redirecting through winx-88.com without
 * risking the ad account. So the domain belongs to the campaign, not to a
 * global env var.
 *
 * NULL = use the platform default (APP_BASE_URL), which is exactly how every
 * existing channel behaved before this column existed.
 *
 * Values are stored as a full origin ("https://winx88.net") and are validated
 * against the TRACKING_DOMAINS allowlist on write — never free text, or an
 * admin typo would mint links that 404 for a campaign that has already been
 * paid for.
 */
export class ChannelTrackingDomain2090000000000 implements MigrationInterface {
  name = 'ChannelTrackingDomain2090000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.marketing_channels
        ADD COLUMN IF NOT EXISTS tracking_domain VARCHAR(255);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.marketing_channels DROP COLUMN IF EXISTS tracking_domain;
    `);
  }
}

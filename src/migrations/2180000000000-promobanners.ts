import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HOME PROMO BANNERS — the linked tile strip under the shortcut row on the
 * player home screen (the "Daily Cashback 10%" / "Refer & Earn 45%" pair).
 *
 * The artwork carries its own call-to-action ("PLAY NOW", "INVITE NOW") baked
 * into the image, so a tile is simply a clickable image — there is deliberately
 * no CTA text column. Overlaying our own button would double up on what the
 * designer already drew. `title_en` / `title_bn` exist for the img alt text and
 * for the admin list, not for display over the banner.
 *
 * Targeting reuses the same CATEGORY / ROUTE / EXTERNAL contract as
 * `home_shortcuts` (see src/common/link-target.ts), so "which link opens" is
 * entirely an admin decision and EXTERNAL values are validated as absolute
 * http(s) URLs before they are ever rendered into an anchor.
 *
 * No seed rows: the two banners in the mockup are finished artwork the admin
 * uploads. Seeding rows with no image would render an empty strip.
 *
 * Idempotent.
 */
export class PromoBanners2180000000000 implements MigrationInterface {
  name = 'PromoBanners2180000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.home_promo_banners (
        id            SERIAL PRIMARY KEY,
        title_en      VARCHAR(80)  NOT NULL,
        title_bn      VARCHAR(80),
        image_url     VARCHAR(500),
        target_type   VARCHAR(20)  NOT NULL,
        target_value  VARCHAR(500) NOT NULL,
        requires_auth BOOLEAN      NOT NULL DEFAULT false,
        sort_order    INTEGER      NOT NULL DEFAULT 0,
        is_active     BOOLEAN      NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_promo_banner_target_type
          CHECK (target_type IN ('CATEGORY','ROUTE','EXTERNAL'))
      );
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_home_promo_banners_active_order
        ON public.home_promo_banners (sort_order, id) WHERE is_active;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_home_promo_banners_active_order;`);
    await q.query(`DROP TABLE IF EXISTS public.home_promo_banners;`);
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PROMOTION CMS — the few fields the player-facing promotions screens need.
 *
 * `promotion_cms` already carries nearly everything: bilingual title /
 * description / rich `content_*` HTML, both banner sizes, the schedule,
 * `show_remaining_time`, `allow_apply`, `redirect_target`, eligibility and
 * ordering. Only four things were missing, so this adds those rather than a
 * second CMS.
 *
 * 1. `category` — the promotions-screen filter chips (All / Welcome / Reload /
 *    Cashback / VIP / Refer). This CANNOT reuse `tags`: those are GAME
 *    categories (SLOT, LIVE, SPORTS…) describing where a bonus may be wagered,
 *    and the player screens use them for the "Wide Game Selection" line. It
 *    also cannot reuse `promotions.kind`, because a card need not link to an
 *    engine promotion at all — the Telegram/Facebook follow card and the
 *    refer-a-friend card are pure marketing with no `promotion_id`.
 *
 * 2. `badge_*` — the corner flag on a card ("NEW PLAYERS ONLY", "EVERY
 *    DEPOSIT", "HOT"). Free text per locale; the designs vary per campaign.
 *
 * 3. `cta_label_*` / `cta_url` — the button. `redirect_target` already says
 *    WHERE an in-app button goes, but not what it SAYS, and an external CTA
 *    (a Telegram channel) had nowhere to put its URL.
 *
 * 4. `terms_*` — Terms & Conditions, shown in its own collapsible section.
 *    Optional: where it is empty the section is hidden and `content_*` carries
 *    the whole body, exactly as today.
 *
 * NOT added: the detail page's key-facts grid. Those are derived at read time
 * from the joined promotion (`bonus_value`, `max_bonus`, `min_amount`) and from
 * `tags`, so they cannot drift out of sync with the promotion engine and give
 * the admin nothing extra to maintain.
 *
 * Every column is nullable with a safe default, so existing rows keep working
 * untouched. Idempotent.
 */
export class PromotionCmsStorefront2220000000000 implements MigrationInterface {
  name = 'PromotionCmsStorefront2220000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.promotion_cms
        ADD COLUMN IF NOT EXISTS category      VARCHAR(20) NOT NULL DEFAULT 'OTHER',
        ADD COLUMN IF NOT EXISTS badge_en      VARCHAR(40),
        ADD COLUMN IF NOT EXISTS badge_bn      VARCHAR(60),
        ADD COLUMN IF NOT EXISTS cta_label_en  VARCHAR(40),
        ADD COLUMN IF NOT EXISTS cta_label_bn  VARCHAR(60),
        ADD COLUMN IF NOT EXISTS cta_url       VARCHAR(500),
        ADD COLUMN IF NOT EXISTS terms_en      TEXT,
        ADD COLUMN IF NOT EXISTS terms_bn      TEXT;
    `);

    await q.query(`
      ALTER TABLE public.promotion_cms
        DROP CONSTRAINT IF EXISTS promotion_cms_category_check;
    `);
    await q.query(`
      ALTER TABLE public.promotion_cms
        ADD CONSTRAINT promotion_cms_category_check
        CHECK (category IN ('WELCOME','RELOAD','CASHBACK','VIP','REFER','FREEBIE','OTHER'));
    `);

    // The promotions screen reads "active cards for this currency in a
    // category, in order".
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_promotion_cms_category
        ON public.promotion_cms (currency, category, sequence)
        WHERE is_active = TRUE;
    `);

    /*
     * Best-effort backfill from the linked promotion's kind, so existing cards
     * land on a sensible chip instead of all sitting under OTHER. Only touches
     * rows still on the default, and only where the mapping is unambiguous —
     * DEPOSIT is deliberately left alone because a deposit promotion may be a
     * welcome offer or a routine reload, and only an admin knows which.
     */
    await q.query(`
      UPDATE public.promotion_cms pc
         SET category = CASE p.kind
                          WHEN 'REGISTRATION' THEN 'WELCOME'
                          WHEN 'RELOAD'       THEN 'RELOAD'
                          WHEN 'CASHBACK'     THEN 'CASHBACK'
                          WHEN 'REBATE'       THEN 'CASHBACK'
                          WHEN 'FREE_REWARD'  THEN 'FREEBIE'
                          ELSE pc.category
                        END
        FROM public.promotions p
       WHERE p.id = pc.promotion_id
         AND pc.category = 'OTHER';
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_promotion_cms_category;`);
    await q.query(`
      ALTER TABLE public.promotion_cms
        DROP CONSTRAINT IF EXISTS promotion_cms_category_check;
    `);
    await q.query(`
      ALTER TABLE public.promotion_cms
        DROP COLUMN IF EXISTS category,
        DROP COLUMN IF EXISTS badge_en,
        DROP COLUMN IF EXISTS badge_bn,
        DROP COLUMN IF EXISTS cta_label_en,
        DROP COLUMN IF EXISTS cta_label_bn,
        DROP COLUMN IF EXISTS cta_url,
        DROP COLUMN IF EXISTS terms_en,
        DROP COLUMN IF EXISTS terms_bn;
    `);
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HOME SHORTCUTS — the round "stories" icon row at the top of the player home
 * screen (Hot Games, New Games, Promotions, Big Wins, Live Casino, VIP Club,
 * Telegram), fully admin-managed.
 *
 * TARGET TYPES — this is the "what type of icon is this" the admin picks:
 *   CATEGORY  target_value = a game category key the panel already understands
 *             ('slot', 'Live Casino', 'Fishing', 'Crash', 'Poker'). Opens the
 *             existing inline provider picker.
 *   ROUTE     target_value = an in-app path ('/promotion', '/jackpots',
 *             '/profile/vip-status'). Navigated with the router.
 *   EXTERNAL  target_value = an absolute off-site URL. This is the social case
 *             (Telegram, WhatsApp, Facebook…) — opened in a new tab with
 *             rel="noopener noreferrer".
 *
 * `icon_url` is NULLABLE on purpose: a row can be created before its artwork is
 * uploaded, and the panel falls back to a neutral placeholder rather than a
 * broken image. It holds either an absolute S3 URL (admin upload) or a path
 * relative to the player panel's own public/ folder (the seeded defaults).
 *
 * `requires_auth` exists because some shortcuts point at protected routes (VIP
 * Club). Without it a signed-out tap would bounce off the route guard; with it
 * the panel opens the login modal instead.
 *
 * Seeds the seven shortcuts from the approved mockup, pointing at the default
 * artwork shipped in the panel's public/shortcuts/ folder. Seeding is guarded
 * by NOT EXISTS so re-running never duplicates rows, and so an environment
 * where the admin has already curated the row is left alone.
 *
 * Idempotent.
 */
export class HomeShortcuts2170000000000 implements MigrationInterface {
  name = 'HomeShortcuts2170000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.home_shortcuts (
        id            SERIAL PRIMARY KEY,
        label_en      VARCHAR(60)  NOT NULL,
        label_bn      VARCHAR(60),
        icon_url      VARCHAR(500),
        badge         VARCHAR(10),
        target_type   VARCHAR(20)  NOT NULL,
        target_value  VARCHAR(500) NOT NULL,
        requires_auth BOOLEAN      NOT NULL DEFAULT false,
        sort_order    INTEGER      NOT NULL DEFAULT 0,
        is_active     BOOLEAN      NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_shortcut_target_type
          CHECK (target_type IN ('CATEGORY','ROUTE','EXTERNAL')),
        CONSTRAINT chk_shortcut_badge
          CHECK (badge IS NULL OR badge IN ('LIVE','NEW','HOT'))
      );
    `);

    // The public endpoint only ever reads active rows in display order.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_home_shortcuts_active_order
        ON public.home_shortcuts (sort_order, id) WHERE is_active;
    `);

    await q.query(`
      INSERT INTO public.home_shortcuts
        (label_en, label_bn, icon_url, badge, target_type, target_value, requires_auth, sort_order)
      SELECT * FROM (VALUES
        ('Hot Games',   'হট গেমস',       '/shortcuts/hot-games.png',   'LIVE', 'ROUTE',    '/games/hot',            false, 10),
        ('New Games',   'নতুন গেমস',      '/shortcuts/new-games.png',   'NEW',  'ROUTE',    '/games/new',            false, 20),
        ('Promotions',  'প্রোমোশন',       '/shortcuts/promotions.png',  NULL,   'ROUTE',    '/promotion',            false, 30),
        ('Big Wins',    'বড় জয়',         '/shortcuts/big-wins.png',    NULL,   'ROUTE',    '/jackpots',             false, 40),
        ('Live Casino', 'লাইভ ক্যাসিনো',  '/shortcuts/live-casino.png', 'LIVE', 'CATEGORY', 'Live Casino',           false, 50),
        ('VIP Club',    'ভিআইপি ক্লাব',   '/shortcuts/vip-club.png',    NULL,   'ROUTE',    '/profile/vip-status',   true,  60),
        ('Telegram',    'টেলিগ্রাম',       '/shortcuts/telegram.png',    NULL,   'EXTERNAL', 'https://t.me/',         false, 70)
      ) AS seed(label_en, label_bn, icon_url, badge, target_type, target_value, requires_auth, sort_order)
      WHERE NOT EXISTS (SELECT 1 FROM public.home_shortcuts);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_home_shortcuts_active_order;`);
    await q.query(`DROP TABLE IF EXISTS public.home_shortcuts;`);
  }
}

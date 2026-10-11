import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * game_categories — the category chips on the player home ("All Games, Slots,
 * Live Casino, Sports, Lottery, Fishing, Crash, Table").
 *
 * They were a hardcoded array in the player panel, so adding a category — for
 * example Crash, now that the Nexus catalog can produce one — meant a frontend
 * release. This makes the row admin-managed.
 *
 * `source` is the load-bearing column, because the chips do NOT all read the
 * same place:
 *
 *   OROPLAY_GROUP  key into GET /oroplay/vendors/grouped (what every non-slot
 *                  chip did before this table existed)
 *   SLOT_PROVIDER  the Palace slot provider list, GET /slot/providers
 *   CATALOG        a casino_games.type — how a Nexus-fed category is surfaced
 *   LINK           no popup, just navigate (Sports, Lottery)
 *
 * Seeded with exactly the eight categories that were hardcoded, with their
 * existing behaviour, so this migration changes nothing on its own.
 *
 * Idempotent.
 */
export class GameCategories2280000000000 implements MigrationInterface {
  name = 'GameCategories2280000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.game_categories (
        id            SERIAL       PRIMARY KEY,
        -- Stable key the frontend keys its active-chip state on.
        key           VARCHAR(40)  NOT NULL UNIQUE,
        label_en      VARCHAR(60)  NOT NULL,
        label_bn      VARCHAR(60),
        -- Optional: the frontend keeps a built-in icon per key and falls back
        -- to it, so an admin only sets this to override the artwork.
        icon_url      VARCHAR(500),
        source        VARCHAR(20)  NOT NULL,
        -- Meaning depends on source: vendor group key, casino_games.type, or
        -- an in-app route. Empty for the "all games" chip.
        value         VARCHAR(120) NOT NULL DEFAULT '',
        requires_auth BOOLEAN      NOT NULL DEFAULT FALSE,
        sort_order    INTEGER      NOT NULL DEFAULT 0,
        is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT chk_game_category_source
          CHECK (source IN ('ALL', 'OROPLAY_GROUP', 'SLOT_PROVIDER', 'CATALOG', 'LINK'))
      );
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_game_categories_active_order
        ON public.game_categories (sort_order, id) WHERE is_active;
    `);

    await q.query(`
      INSERT INTO public.game_categories
        (key, label_en, label_bn, source, value, requires_auth, sort_order)
      SELECT * FROM (VALUES
        ('all',     'All Games',   'সব গেমস',        'ALL',           '',             false, 10),
        ('slot',    'Slots',       'স্লটস',           'SLOT_PROVIDER', 'slot',         false, 20),
        ('casino',  'Live Casino', 'লাইভ ক্যাসিনো',  'OROPLAY_GROUP', 'Live Casino',  true,  30),
        ('sports',  'Sports',      'স্পোর্টস',        'LINK',          '/sports',      true,  40),
        ('lottery', 'Lottery',     'লটারি',          'LINK',          '/lotto',       true,  50),
        ('fishing', 'Fishing',     'ফিশিং',          'OROPLAY_GROUP', 'Fishing',      true,  60),
        ('crash',   'Crash',       'ক্র্যাশ',          'OROPLAY_GROUP', 'Crash',        true,  70),
        ('table',   'Table',       'টেবিল',          'OROPLAY_GROUP', 'Poker',        true,  80)
      ) AS seed(key, label_en, label_bn, source, value, requires_auth, sort_order)
      WHERE NOT EXISTS (SELECT 1 FROM public.game_categories);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS public.game_categories;`);
  }
}

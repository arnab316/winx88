import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin curation of game categories and display names.
 *
 * The catalog sync UPSERTS `name` and `type` on every run, so anything an admin
 * edited directly on `casino_games` is silently undone the next time the sync
 * runs. Curation therefore lives OUTSIDE the synced row, and the sync resolves
 * the final value instead of overwriting it:
 *
 *   effective = per-game override  ->  first matching rule  ->  derived_type
 *
 * `casino_games.derived_type` is the third leg and the reason the whole thing
 * is reversible: it records what the sync itself worked out, so deleting a rule
 * or an override restores the original category without re-pulling 3,500 games
 * from the provider.
 *
 * Keyed by `uuid` rather than by provider + game code so the same mechanism
 * works for every aggregator in the shared catalog, not just Nexus.
 *
 * Idempotent.
 */
export class GameCategoryCuration2270000000000 implements MigrationInterface {
  name = 'GameCategoryCuration2270000000000';

  public async up(q: QueryRunner): Promise<void> {
    // What the sync derived, before any curation is applied.
    await q.query(`
      ALTER TABLE public.casino_games
        ADD COLUMN IF NOT EXISTS derived_type VARCHAR(40);
    `);
    // Backfill: for rows synced before this existed, the current type IS the
    // derived one — nothing has been curated yet.
    await q.query(`
      UPDATE public.casino_games
         SET derived_type = type
       WHERE derived_type IS NULL;
    `);

    // ── Per-game override: pins one game, beats every rule ────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.casino_game_overrides (
        game_uuid     VARCHAR(190) PRIMARY KEY,
        -- NULL means "not overridden"; the two are independent, so an admin can
        -- rename a game without re-filing it, and vice versa.
        type          VARCHAR(40),
        display_name  VARCHAR(255),
        note          VARCHAR(255),
        updated_by    BIGINT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── Rules: how 3,500 games get curated without 3,500 clicks ───────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.casino_game_rules (
        id             SERIAL       PRIMARY KEY,
        -- Lower runs first. The FIRST match wins, so ordering is the whole
        -- semantics of the table.
        priority       INTEGER      NOT NULL DEFAULT 100,
        -- NULL = matches any. Both narrow the rule; neither is required.
        aggregator     VARCHAR(20),
        provider_code  VARCHAR(100),
        -- Which field the pattern is tested against.
        match_field    VARCHAR(16)  NOT NULL DEFAULT 'name',
        -- Case-insensitive. A plain substring unless is_regex, because most
        -- admins should not have to write a regex to file crash games.
        pattern        VARCHAR(200) NOT NULL,
        is_regex       BOOLEAN      NOT NULL DEFAULT FALSE,
        type           VARCHAR(40)  NOT NULL,
        is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT chk_game_rule_match_field
          CHECK (match_field IN ('name', 'game_code'))
      );
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_casino_game_rules_order
        ON public.casino_game_rules (priority, id) WHERE is_active;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS public.casino_game_rules;`);
    await q.query(`DROP TABLE IF EXISTS public.casino_game_overrides;`);
    await q.query(`ALTER TABLE public.casino_games DROP COLUMN IF EXISTS derived_type;`);
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCasinoAndTables1800000000000 implements MigrationInterface {
  name = 'CreateCasinoAndTables1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. casino_games
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.casino_games (
        uuid                          VARCHAR(255) PRIMARY KEY,
        name                          VARCHAR(255) NOT NULL,
        image                         VARCHAR(500),
        type                          VARCHAR(50) NOT NULL,
        provider                      VARCHAR(100) NOT NULL,
        provider_id                   INTEGER,
        game_symbol                   VARCHAR(100),
        lang                          INTEGER DEFAULT 1,
        technology                    VARCHAR(50) DEFAULT 'HTML5',
        has_lobby                     INTEGER DEFAULT 0,
        is_mobile                     INTEGER DEFAULT 1,
        has_freespins                 INTEGER DEFAULT 0,
        has_tables                    INTEGER DEFAULT 0,
        freespin_valid_until_full_day INTEGER DEFAULT 0,
        parameters                    JSONB,
        tags                          JSONB DEFAULT '[]'::jsonb,
        images                        JSONB DEFAULT '[]'::jsonb,
        related_games                 JSONB DEFAULT '[]'::jsonb,
        is_new                        BOOLEAN DEFAULT false,
        vendor_code                   VARCHAR(100),
        game_code                     VARCHAR(100),
        slug                          VARCHAR(255),
        under_maintenance             BOOLEAN DEFAULT false,
        created_at                    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at                    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 2. casino_game_tags
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.casino_game_tags (
        id          VARCHAR(100) PRIMARY KEY,
        name        VARCHAR(255),
        category    JSONB
      );
    `);

    // 3. casino_game_logs
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.casino_game_logs (
        id              BIGSERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
        user_name       VARCHAR(255),
        game_uuid       VARCHAR(255),
        game_name       VARCHAR(255),
        game_provider   VARCHAR(100),
        game_type       VARCHAR(50),
        action          VARCHAR(50),
        type            VARCHAR(50),
        amount          NUMERIC(15,2) NOT NULL,
        tx_id           VARCHAR(255),
        transaction_id  VARCHAR(255) UNIQUE,
        round_id        VARCHAR(255),
        rollback        VARCHAR(255),
        user_data       JSONB,
        created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 4. sports_bet_logs
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.sports_bet_logs (
        id              BIGSERIAL PRIMARY KEY,
        user_name       VARCHAR(255),
        bet_list        JSONB,
        trans_id        VARCHAR(255),
        trans_hist_id   VARCHAR(255),
        amount          NUMERIC(15,2) NOT NULL,
        type            VARCHAR(50),
        date_time       VARCHAR(100),
        created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 5. user_cash_logs
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.user_cash_logs (
        id              BIGSERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
        user_data       JSONB,
        amount          NUMERIC(15,2) NOT NULL,
        before_balance  NUMERIC(15,2) NOT NULL,
        after_balance   NUMERIC(15,2) NOT NULL,
        t_type          VARCHAR(50),
        type            VARCHAR(50),
        created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 6. partner_profit_logs
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.partner_profit_logs (
        id                BIGSERIAL PRIMARY KEY,
        partner_user_id   VARCHAR(255),
        partner_nickname  VARCHAR(255),
        user_id           INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
        user_nickname     VARCHAR(255),
        user_level        VARCHAR(50),
        amount            NUMERIC(15,2) NOT NULL,
        before_balance    NUMERIC(15,2) NOT NULL,
        after_balance     NUMERIC(15,2) NOT NULL,
        type              VARCHAR(50),
        created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.partner_profit_logs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.user_cash_logs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.sports_bet_logs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.casino_game_logs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.casino_game_tags;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.casino_games;`);
  }
}

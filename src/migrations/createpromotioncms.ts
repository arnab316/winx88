import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePromotionCms1680000000005 implements MigrationInterface {
  name = 'CreatePromotionCms1680000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════════════════════
    // PROMOTION CMS
    //   Marketing/display layer. Each row is a "card" that links
    //   to an underlying promotions row. One promotion can have
    //   multiple CMS cards (one per audience/page placement).
    //
    //   Bilingual: EN-BD + BN-BD per the screenshots.
    //   Tags: JSONB array (Sport, LiveCasino, Slot, Table, etc.).
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.promotion_cms (
        id                  BIGSERIAL PRIMARY KEY,
        promotion_id        BIGINT,
        currency            VARCHAR(10)   NOT NULL DEFAULT 'BDT',

        -- Display ordering on the promotion list page
        sequence            INTEGER       NOT NULL DEFAULT 0,

        -- Tags (JSONB array of strings: ['Sport','LiveCasino','Slot','Table'])
        tags                JSONB         NOT NULL DEFAULT '[]'::jsonb,

        -- Display rules
        display_before_login BOOLEAN      NOT NULL DEFAULT TRUE,
        display_after_login  BOOLEAN      NOT NULL DEFAULT TRUE,
        show_remaining_time  BOOLEAN      NOT NULL DEFAULT FALSE,
        allow_apply          BOOLEAN      NOT NULL DEFAULT TRUE,

        -- Where the "Apply" button takes the user
        redirect_target     VARCHAR(30)   NOT NULL DEFAULT 'PROMO_CENTER',

        -- Eligibility (overrides engine for display only — engine still
        -- enforces real eligibility at claim time)
        eligible_member_group_id BIGINT,

        -- Date window (CMS visibility — independent of engine validity)
        starts_at           TIMESTAMPTZ,
        ends_at             TIMESTAMPTZ,

        -- ─── EN-BD content ───
        title_en            VARCHAR(200),
        description_en      TEXT,
        content_en          TEXT,             -- rich HTML body
        banner_en_url       TEXT,
        small_banner_en_url TEXT,

        -- ─── BN-BD content ───
        title_bn            VARCHAR(200),
        description_bn      TEXT,
        content_bn          TEXT,
        banner_bn_url       TEXT,
        small_banner_bn_url TEXT,

        -- Buttons (Button Generation in screenshot 4)
        button_show_with_title       BOOLEAN NOT NULL DEFAULT FALSE,
        button_show_when_eligible    BOOLEAN NOT NULL DEFAULT FALSE,
        button_show_in_promotions    BOOLEAN NOT NULL DEFAULT TRUE,
        button_show_in_promo_center  BOOLEAN NOT NULL DEFAULT TRUE,

        is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
        created_by_admin_id BIGINT,
        updated_by_admin_id BIGINT,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

        CONSTRAINT promo_cms_promotion_fk FOREIGN KEY (promotion_id)
          REFERENCES public.promotions(id) ON DELETE SET NULL,
        CONSTRAINT promo_cms_member_group_fk FOREIGN KEY (eligible_member_group_id)
          REFERENCES public.member_groups(id) ON DELETE SET NULL,
        CONSTRAINT promo_cms_redirect_check
          CHECK (redirect_target IN ('PROMO_CENTER','DEPOSIT','VIP','NONE'))
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_cms_active_sequence
        ON public.promotion_cms(is_active, sequence ASC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_cms_currency
        ON public.promotion_cms(currency);
    `);
    // GIN index for tag queries: WHERE tags @> '["Sport"]'
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_cms_tags_gin
        ON public.promotion_cms USING GIN (tags);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_cms_promotion_id
        ON public.promotion_cms(promotion_id) WHERE promotion_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.promotion_cms;`);
  }
}
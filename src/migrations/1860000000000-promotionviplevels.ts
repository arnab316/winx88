import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * VIP-level eligibility: a promotion can be restricted to specific VIP tiers
 * (vip_level_config.level — Normal/Elite/Pro/…/Mythic). Parallels the
 * promotion_member_groups join table. No constraint set = open to all tiers.
 */
export class PromotionVipLevels1860000000000 implements MigrationInterface {
  name = 'PromotionVipLevels1860000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.promotion_vip_levels (
        promotion_id BIGINT  NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
        vip_level    INTEGER NOT NULL,
        PRIMARY KEY (promotion_id, vip_level)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_pvl_promotion ON public.promotion_vip_levels(promotion_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.promotion_vip_levels;`);
  }
}

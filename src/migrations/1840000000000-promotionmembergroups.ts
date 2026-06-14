import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi member-group eligibility: a promotion can target MULTIPLE member
 * groups / VIP tiers (not just the single promotions.member_group_id).
 * Join table; the legacy single column stays for backward compatibility.
 */
export class PromotionMemberGroups1840000000000 implements MigrationInterface {
  name = 'PromotionMemberGroups1840000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.promotion_member_groups (
        promotion_id    BIGINT NOT NULL REFERENCES public.promotions(id)     ON DELETE CASCADE,
        member_group_id BIGINT NOT NULL REFERENCES public.member_groups(id)  ON DELETE CASCADE,
        PRIMARY KEY (promotion_id, member_group_id)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_pmg_promotion ON public.promotion_member_groups(promotion_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_pmg_group ON public.promotion_member_groups(member_group_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.promotion_member_groups;`);
  }
}

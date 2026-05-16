import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Herobanner003155 implements MigrationInterface {
 name = 'Herobanner1726567891234';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hero_banners (
        id SERIAL PRIMARY KEY,
        desktop_image TEXT,
        mobile_image TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS hero_banners
    `);
  }
}
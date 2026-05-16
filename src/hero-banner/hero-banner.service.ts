import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HeroBannerS3Service } from '../common/services/hero-banner-s3.service';

@Injectable()
export class HeroBannerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly s3Service: HeroBannerS3Service,
  ) {}

  async createBanner(
    desktopFile?: Express.Multer.File,   // ✅ optional, no more undefined error
    mobileFile?: Express.Multer.File,
  ) {
    let desktopImage: string | undefined;  // ✅ string | undefined, not null
    let mobileImage: string | undefined;

    if (desktopFile) {
      desktopImage = await this.s3Service.uploadHeroBanner(desktopFile, 'desktop');
    }
    if (mobileFile) {
      mobileImage = await this.s3Service.uploadHeroBanner(mobileFile, 'mobile');
    }

    const result = await this.dataSource.query(
      `INSERT INTO hero_banners (desktop_image, mobile_image)
       VALUES ($1, $2)
       RETURNING *`,
      [desktopImage ?? null, mobileImage ?? null],
    );

    return result[0];
  }

  async getAllBanners() {
    return this.dataSource.query(
      `SELECT * FROM hero_banners ORDER BY id DESC`,
    );
  }

async getActiveBanner() {
  const result = await this.dataSource.query(
    `SELECT * FROM hero_banners
     WHERE is_active = true
     ORDER BY id DESC`
  );

  return result;
}

  async updateBanner(
    id: number,
    desktopFile?: Express.Multer.File,
    mobileFile?: Express.Multer.File,
  ) {
    // Fetch existing row first
    const existing = await this.dataSource.query(
      `SELECT * FROM hero_banners WHERE id = $1`,
      [id],
    );
    if (!existing[0]) throw new NotFoundException(`Banner #${id} not found`);

    let desktopImage: string = existing[0].desktop_image;
    let mobileImage: string = existing[0].mobile_image;

    if (desktopFile) {
      desktopImage = await this.s3Service.uploadHeroBanner(desktopFile, 'desktop');
    }
    if (mobileFile) {
      mobileImage = await this.s3Service.uploadHeroBanner(mobileFile, 'mobile');
    }

    const result = await this.dataSource.query(
      `UPDATE hero_banners
       SET desktop_image = $1, mobile_image = $2
       WHERE id = $3
       RETURNING *`,
      [desktopImage, mobileImage, id],
    );
    return result[0];
  }

  async toggleActive(id: number, isActive: boolean) {
    const result = await this.dataSource.query(
      `UPDATE hero_banners SET is_active = $1 WHERE id = $2 RETURNING *`,
      [isActive, id],
    );
    if (!result[0]) throw new NotFoundException(`Banner #${id} not found`);
    return result[0];
  }

  async deleteBanner(id: number) {
    const result = await this.dataSource.query(
      `DELETE FROM hero_banners WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!result[0]) throw new NotFoundException(`Banner #${id} not found`);
    return { deleted: true, id };
  }
}
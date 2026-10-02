import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  assertLinkTarget,
  unwrapReturning,
  type LinkTargetType,
} from 'src/common/link-target';
import { MediaS3Service } from 'src/common/services/media-s3.service';

export interface PromoBannerInput {
  titleEn: string;
  titleBn?: string | null;
  targetType: LinkTargetType;
  targetValue: string;
  requiresAuth?: boolean;
  sortOrder?: number;
  isActive?: boolean;
  imageUrl?: string | null;
}

@Injectable()
export class PromoBannersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly media: MediaS3Service,
  ) {}

  /* ───────────────────────────── Public ───────────────────────────── */

  /**
   * Active banners in display order. Rows without artwork are withheld — a
   * banner IS its image, so an image-less row would render as a blank tile.
   */
  async listActive() {
    const rows = await this.dataSource.query(
      `SELECT id, title_en, title_bn, image_url, target_type, target_value,
              requires_auth, sort_order
         FROM public.home_promo_banners
        WHERE is_active AND image_url IS NOT NULL AND image_url <> ''
        ORDER BY sort_order ASC, id ASC`,
    );
    return { items: rows.map(this.toDto), total: rows.length };
  }

  /* ───────────────────────────── Admin ────────────────────────────── */

  async listAll() {
    const rows = await this.dataSource.query(
      `SELECT id, title_en, title_bn, image_url, target_type, target_value,
              requires_auth, sort_order, is_active, created_at, updated_at
         FROM public.home_promo_banners
        ORDER BY sort_order ASC, id ASC`,
    );
    return {
      items: rows.map((r: any) => ({
        ...this.toDto(r),
        isActive: r.is_active,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      total: rows.length,
    };
  }

  async create(input: PromoBannerInput, image?: Express.Multer.File) {
    assertLinkTarget(input.targetType, input.targetValue);

    const imageUrl = image
      ? await this.media.uploadImage(image, 'promo-banners')
      : (input.imageUrl ?? null);

    const rows = await this.dataSource.query(
      `INSERT INTO public.home_promo_banners
         (title_en, title_bn, image_url, target_type, target_value,
          requires_auth, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,
               COALESCE($7, (SELECT COALESCE(MAX(sort_order),0)+10 FROM public.home_promo_banners)),
               COALESCE($8,true))
       RETURNING *`,
      [
        input.titleEn,
        input.titleBn ?? null,
        imageUrl,
        input.targetType,
        input.targetValue,
        input.requiresAuth ?? false,
        input.sortOrder ?? null,
        input.isActive ?? null,
      ],
    );
    return this.toDto(rows[0]);
  }

  async update(id: number, input: Partial<PromoBannerInput>, image?: Express.Multer.File) {
    const existing = await this.dataSource.query(
      `SELECT * FROM public.home_promo_banners WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Banner not found');

    // Validate the combination that will actually be stored, since a partial
    // update may change the type, the value, or both.
    assertLinkTarget(
      (input.targetType ?? existing[0].target_type) as LinkTargetType,
      input.targetValue ?? existing[0].target_value,
    );

    const imageUrl = image
      ? await this.media.uploadImage(image, 'promo-banners')
      : input.imageUrl;

    const rows = unwrapReturning(
      await this.dataSource.query(
        `UPDATE public.home_promo_banners SET
           title_en      = COALESCE($2, title_en),
           title_bn      = COALESCE($3, title_bn),
           image_url     = COALESCE($4, image_url),
           target_type   = COALESCE($5, target_type),
           target_value  = COALESCE($6, target_value),
           requires_auth = COALESCE($7, requires_auth),
           sort_order    = COALESCE($8, sort_order),
           is_active     = COALESCE($9, is_active),
           updated_at    = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          input.titleEn ?? null,
          input.titleBn ?? null,
          imageUrl ?? null,
          input.targetType ?? null,
          input.targetValue ?? null,
          input.requiresAuth ?? null,
          input.sortOrder ?? null,
          input.isActive ?? null,
        ],
      ),
    );
    return this.toDto(rows[0]);
  }

  async remove(id: number) {
    const rows = unwrapReturning(
      await this.dataSource.query(
        `DELETE FROM public.home_promo_banners WHERE id = $1 RETURNING id`,
        [id],
      ),
    );
    if (!rows.length) throw new NotFoundException('Banner not found');
    return { id, deleted: true };
  }

  async reorder(ids: number[]) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException('ids must be a non-empty array');
    }
    await this.dataSource.query(
      `UPDATE public.home_promo_banners AS b
          SET sort_order = v.ord * 10, updated_at = NOW()
         FROM (SELECT UNNEST($1::int[]) AS id,
                      GENERATE_SERIES(1, array_length($1::int[], 1)) AS ord) AS v
        WHERE b.id = v.id`,
      [ids],
    );
    return this.listAll();
  }

  private toDto = (r: any) => ({
    id: r.id,
    titleEn: r.title_en,
    titleBn: r.title_bn ?? null,
    imageUrl: r.image_url ?? null,
    targetType: r.target_type as LinkTargetType,
    targetValue: r.target_value,
    requiresAuth: r.requires_auth,
    sortOrder: r.sort_order,
  });
}

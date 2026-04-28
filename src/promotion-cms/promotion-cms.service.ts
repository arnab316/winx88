// src/promotion-cms/promotion-cms.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreatePromotionCmsDto,
  UpdatePromotionCmsDto,
  ListPromotionCmsQueryDto,
  FeedQueryDto,
  ReorderCmsDto,
  SupportedLang,
} from './dto/promotion-cms.dto';

/**
 * Single Responsibility: manage promotion display content
 * (banners, bilingual text, sequence ordering, audience filters).
 *
 * Does NOT credit bonuses, validate eligibility for claiming, or
 * enforce business rules — that's PromotionEngineService's job.
 *
 * The CMS row may link to a promotion (engine row) so the "Apply"
 * button on the frontend knows which promo to claim. That linkage
 * is optional — pure marketing announcements without a claim flow
 * are also valid (promotion_id can be null).
 */
@Injectable()
export class PromotionCmsService {
  constructor(private dataSource: DataSource) {}

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CREATE
  // ═════════════════════════════════════════════════════════════
  async create(dto: CreatePromotionCmsDto, adminId: number) {
    // Verify linked promotion exists if provided
    if (dto.promotionId) {
      const p = await this.dataSource.query(
        `SELECT id FROM promotions WHERE id = $1`,
        [dto.promotionId],
      );
      if (!p.length) throw new BadRequestException('Linked promotion not found');
    }

    // Verify member group if provided
    if (dto.eligibleMemberGroupId) {
      const g = await this.dataSource.query(
        `SELECT id FROM member_groups WHERE id = $1`,
        [dto.eligibleMemberGroupId],
      );
      if (!g.length) throw new BadRequestException('Member group not found');
    }

    // At least one language must have a title
    if (!dto.titleEn && !dto.titleBn) {
      throw new BadRequestException(
        'At least one of titleEn or titleBn must be provided',
      );
    }

    const result = await this.dataSource.query(
      `INSERT INTO promotion_cms
        (promotion_id, currency, sequence, tags,
         display_before_login, display_after_login, show_remaining_time, allow_apply,
         redirect_target, eligible_member_group_id,
         starts_at, ends_at,
         title_en, description_en, content_en, banner_en_url, small_banner_en_url,
         title_bn, description_bn, content_bn, banner_bn_url, small_banner_bn_url,
         button_show_with_title, button_show_when_eligible,
         button_show_in_promotions, button_show_in_promo_center,
         is_active, created_by_admin_id, updated_by_admin_id)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$28)
       RETURNING *`,
      [
        dto.promotionId ?? null,
        dto.currency ?? 'BDT',
        dto.sequence ?? 0,
        JSON.stringify(dto.tags ?? []),
        dto.displayBeforeLogin ?? true,
        dto.displayAfterLogin ?? true,
        dto.showRemainingTime ?? false,
        dto.allowApply ?? true,
        dto.redirectTarget ?? 'PROMO_CENTER',
        dto.eligibleMemberGroupId ?? null,
        dto.startsAt ?? null,
        dto.endsAt ?? null,
        dto.titleEn ?? null,
        dto.descriptionEn ?? null,
        dto.contentEn ?? null,
        null, // banner_en_url — set via uploadBanner endpoint
        null, // small_banner_en_url
        dto.titleBn ?? null,
        dto.descriptionBn ?? null,
        dto.contentBn ?? null,
        null, // banner_bn_url
        null, // small_banner_bn_url
        dto.buttonShowWithTitle ?? false,
        dto.buttonShowWhenEligible ?? false,
        dto.buttonShowInPromotions ?? true,
        dto.buttonShowInPromoCenter ?? true,
        dto.isActive ?? true,
        adminId,
      ],
    );
    return result[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: UPDATE
  // ═════════════════════════════════════════════════════════════
  async update(id: number, dto: UpdatePromotionCmsDto, adminId: number) {
    const existing = await this.dataSource.query(
      `SELECT id FROM promotion_cms WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('CMS entry not found');

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    const map: Record<string, any> = {
      promotion_id:                 dto.promotionId,
      currency:                     dto.currency,
      sequence:                     dto.sequence,
      display_before_login:         dto.displayBeforeLogin,
      display_after_login:          dto.displayAfterLogin,
      show_remaining_time:          dto.showRemainingTime,
      allow_apply:                  dto.allowApply,
      redirect_target:              dto.redirectTarget,
      eligible_member_group_id:     dto.eligibleMemberGroupId,
      starts_at:                    dto.startsAt,
      ends_at:                      dto.endsAt,
      title_en:                     dto.titleEn,
      description_en:               dto.descriptionEn,
      content_en:                   dto.contentEn,
      title_bn:                     dto.titleBn,
      description_bn:               dto.descriptionBn,
      content_bn:                   dto.contentBn,
      button_show_with_title:       dto.buttonShowWithTitle,
      button_show_when_eligible:    dto.buttonShowWhenEligible,
      button_show_in_promotions:    dto.buttonShowInPromotions,
      button_show_in_promo_center:  dto.buttonShowInPromoCenter,
      is_active:                    dto.isActive,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }

    // Tags need JSONB casting
    if (dto.tags !== undefined) {
      fields.push(`tags = $${i++}::jsonb`);
      values.push(JSON.stringify(dto.tags));
    }

    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_by_admin_id = $${i++}`);
    values.push(adminId);
    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await this.dataSource.query(
      `UPDATE promotion_cms SET ${fields.join(', ')}
       WHERE id = $${i} RETURNING *`,
      values,
    );
    return result[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: SET BANNER URLs (after S3 upload)
  //   Called by controller AFTER it uploads the file to S3.
  //   Separate from update so we can do partial banner replacement.
  // ═════════════════════════════════════════════════════════════
  async setBannerUrl(
    id: number,
    lang: SupportedLang,
    size: 'large' | 'small',
    url: string,
    adminId: number,
  ) {
    const colName =
      `${size === 'small' ? 'small_banner' : 'banner'}_${lang}_url`;

    const existing = await this.dataSource.query(
      `SELECT id FROM promotion_cms WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('CMS entry not found');

    const result = await this.dataSource.query(
      `UPDATE promotion_cms
       SET ${colName} = $1, updated_by_admin_id = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [url, adminId, id],
    );
    return result[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: REORDER (bulk sequence update)
  // ═════════════════════════════════════════════════════════════
  async reorder(dto: ReorderCmsDto, adminId: number) {
    if (!dto.items?.length) throw new BadRequestException('No items provided');

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      for (const item of dto.items) {
        if (!Number.isFinite(item.id) || !Number.isFinite(item.sequence)) {
          throw new BadRequestException('Each item must have id and sequence');
        }
        await qr.query(
          `UPDATE promotion_cms
           SET sequence = $1, updated_by_admin_id = $2, updated_at = NOW()
           WHERE id = $3`,
          [item.sequence, adminId, item.id],
        );
      }
      await qr.commitTransaction();
      return { message: 'Reorder applied', count: dto.items.length };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: DELETE
  // ═════════════════════════════════════════════════════════════
  async deleteOrDeactivate(id: number, hard = false) {
    const existing = await this.dataSource.query(
      `SELECT id FROM promotion_cms WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('CMS entry not found');

    if (hard) {
      await this.dataSource.query(
        `DELETE FROM promotion_cms WHERE id = $1`,
        [id],
      );
      return { message: 'CMS entry deleted permanently' };
    }

    await this.dataSource.query(
      `UPDATE promotion_cms SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
      [id],
    );
    return { message: 'CMS entry deactivated' };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST WITH FILTERS
  // ═════════════════════════════════════════════════════════════
  async list(q: ListPromotionCmsQueryDto) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (q.currency)              { where.push(`currency = $${i++}`);    params.push(q.currency); }
    if (q.isActive !== undefined){ where.push(`is_active = $${i++}`);   params.push(q.isActive); }
    if (q.tag)                   { where.push(`tags @> $${i++}::jsonb`); params.push(JSON.stringify([q.tag])); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = q.limit ?? 20;
    const offset = ((q.page ?? 1) - 1) * limit;

    const data = await this.dataSource.query(
      `SELECT cms.*,
              p.title AS promotion_title, p.code AS promotion_code, p.kind AS promotion_kind
       FROM promotion_cms cms
       LEFT JOIN promotions p ON p.id = cms.promotion_id
       ${whereSql}
       ORDER BY cms.is_active DESC, cms.sequence ASC, cms.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );

    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM promotion_cms ${whereSql}`,
      params,
    );

    return { data, page: q.page ?? 1, limit, total: count[0].total };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: GET ONE
  // ═════════════════════════════════════════════════════════════
  async getOne(id: number) {
    const rows = await this.dataSource.query(
      `SELECT cms.*,
              p.title AS promotion_title, p.code AS promotion_code, p.kind AS promotion_kind,
              mg.code AS member_group_code, mg.name AS member_group_name
       FROM promotion_cms cms
       LEFT JOIN promotions p ON p.id = cms.promotion_id
       LEFT JOIN member_groups mg ON mg.id = cms.eligible_member_group_id
       WHERE cms.id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('CMS entry not found');
    return rows[0];
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: FEED (for the homepage / promo center)
  //   Filters by language, login state, tag, currency.
  //   Returns shaped data (one language only) — not raw row.
  // ═════════════════════════════════════════════════════════════
  async feed(q: FeedQueryDto) {
    const lang: SupportedLang = q.lang ?? 'en';
    const params: any[] = [];
    let i = 1;

    const where: string[] = [`cms.is_active = TRUE`];

    // Date window
    where.push(`(cms.starts_at IS NULL OR cms.starts_at <= NOW())`);
    where.push(`(cms.ends_at IS NULL OR cms.ends_at > NOW())`);

    // Login filter
    if (q.loggedIn === true) {
      where.push(`cms.display_after_login = TRUE`);
    } else if (q.loggedIn === false) {
      where.push(`cms.display_before_login = TRUE`);
    }
    // If loggedIn is undefined, return everything — frontend filters

    if (q.currency) {
      where.push(`cms.currency = $${i++}`);
      params.push(q.currency);
    }

    if (q.tag) {
      where.push(`cms.tags @> $${i++}::jsonb`);
      params.push(JSON.stringify([q.tag]));
    }

    const rows = await this.dataSource.query(
      `SELECT
          cms.id,
          cms.promotion_id,
          cms.currency,
          cms.sequence,
          cms.tags,
          cms.show_remaining_time,
          cms.allow_apply,
          cms.redirect_target,
          cms.starts_at,
          cms.ends_at,
          cms.title_${lang}        AS title,
          cms.description_${lang}  AS description,
          cms.content_${lang}      AS content,
          cms.banner_${lang}_url   AS banner_url,
          cms.small_banner_${lang}_url AS small_banner_url,
          cms.button_show_with_title,
          cms.button_show_when_eligible,
          cms.button_show_in_promotions,
          cms.button_show_in_promo_center,
          p.code  AS promotion_code,
          p.kind  AS promotion_kind,
          p.is_active AS promotion_is_active
       FROM promotion_cms cms
       LEFT JOIN promotions p ON p.id = cms.promotion_id
       WHERE ${where.join(' AND ')}
       ORDER BY cms.sequence ASC, cms.created_at DESC`,
      params,
    );

    // Shape: skip entries that have no title in the requested language
    // (frontend gracefully handles, but cleaner to filter here)
    const shaped = rows.filter((r: any) => r.title);

    return { lang, count: shaped.length, data: shaped };
  }
}
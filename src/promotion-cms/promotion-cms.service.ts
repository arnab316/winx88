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
  PublicPromotionCmsQueryDto,
  ReorderPromotionCmsDto,
} from './dto/promotion-cms.dto';

/**
 * Manages content/banner side of promotions (separate from the rules engine).
 *
 * - Admin CRUD over promotion_cms rows.
 * - Public read endpoints that the frontend banner grid consumes.
 * - Per-user eligibility evaluation so the frontend knows whether to
 *   render a card normally, grey it out, or hide it (per `non_eligible_display`).
 */
@Injectable()
export class PromotionCmsService {
  constructor(private readonly dataSource: DataSource) {}

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CREATE
  // ═════════════════════════════════════════════════════════════
  async create(dto: CreatePromotionCmsDto, adminId: number) {
    if (dto.promotionId) {
      const p = await this.dataSource.query(
        `SELECT id FROM promotions WHERE id = $1`,
        [dto.promotionId],
      );
      if (!p.length) throw new BadRequestException('Linked promotion not found');
    }

    if (dto.eligibleMemberGroupId) {
      const g = await this.dataSource.query(
        `SELECT id FROM member_groups WHERE id = $1 AND is_active = TRUE`,
        [dto.eligibleMemberGroupId],
      );
      if (!g.length) throw new BadRequestException('Member group not found or inactive');
    }

    const r = await this.dataSource.query(
      `INSERT INTO promotion_cms
        (promotion_id, currency, sequence, tags,
         display_before_login, display_after_login, show_remaining_time, allow_apply,
         redirect_target, non_eligible_display, eligible_member_group_id,
         starts_at, ends_at,
         title_en, description_en, content_en, banner_en_url, small_banner_en_url,
         title_bn, description_bn, content_bn, banner_bn_url, small_banner_bn_url,
         button_show_with_title, button_show_when_eligible,
         button_show_in_promotions, button_show_in_promo_center,
         is_active, created_by_admin_id, updated_by_admin_id)
       VALUES
        ($1, $2, $3, $4::jsonb,
         $5, $6, $7, $8,
         $9, $10, $11,
         $12, $13,
         $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23,
         $24, $25, $26, $27,
         $28, $29, $29)
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
        dto.nonEligibleDisplay ?? 'GREY',
        dto.eligibleMemberGroupId ?? null,
        dto.startsAt ?? null,
        dto.endsAt ?? null,
        dto.titleEn ?? null,
        dto.descriptionEn ?? null,
        dto.contentEn ?? null,
        dto.bannerEnUrl ?? null,
        dto.smallBannerEnUrl ?? null,
        dto.titleBn ?? null,
        dto.descriptionBn ?? null,
        dto.contentBn ?? null,
        dto.bannerBnUrl ?? null,
        dto.smallBannerBnUrl ?? null,
        dto.buttonShowWithTitle ?? false,
        dto.buttonShowWhenEligible ?? false,
        dto.buttonShowInPromotions ?? true,
        dto.buttonShowInPromoCenter ?? true,
        dto.isActive ?? true,
        adminId,
      ],
    );
    return r[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: UPDATE
  // ═════════════════════════════════════════════════════════════
  async update(id: number, dto: UpdatePromotionCmsDto, adminId: number) {
    const existing = await this.dataSource.query(
      `SELECT id FROM promotion_cms WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Promotion CMS entry not found');

    const map: Record<string, any> = {
      promotion_id:                 dto.promotionId,
      currency:                     dto.currency,
      sequence:                     dto.sequence,
      tags:                         dto.tags !== undefined ? JSON.stringify(dto.tags) : undefined,
      display_before_login:         dto.displayBeforeLogin,
      display_after_login:          dto.displayAfterLogin,
      show_remaining_time:          dto.showRemainingTime,
      allow_apply:                  dto.allowApply,
      redirect_target:              dto.redirectTarget,
      non_eligible_display:         dto.nonEligibleDisplay,
      eligible_member_group_id:     dto.eligibleMemberGroupId,
      starts_at:                    dto.startsAt,
      ends_at:                      dto.endsAt,
      title_en:                     dto.titleEn,
      description_en:               dto.descriptionEn,
      content_en:                   dto.contentEn,
      banner_en_url:                dto.bannerEnUrl,
      small_banner_en_url:          dto.smallBannerEnUrl,
      title_bn:                     dto.titleBn,
      description_bn:               dto.descriptionBn,
      content_bn:                   dto.contentBn,
      banner_bn_url:                dto.bannerBnUrl,
      small_banner_bn_url:          dto.smallBannerBnUrl,
      button_show_with_title:       dto.buttonShowWithTitle,
      button_show_when_eligible:    dto.buttonShowWhenEligible,
      button_show_in_promotions:    dto.buttonShowInPromotions,
      button_show_in_promo_center:  dto.buttonShowInPromoCenter,
      is_active:                    dto.isActive,
    };

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        // tags column needs ::jsonb cast
        if (col === 'tags') fields.push(`${col} = $${i++}::jsonb`);
        else                fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_by_admin_id = $${i++}`);
    values.push(adminId);

    values.push(id);
    const r = await this.dataSource.query(
      `UPDATE promotion_cms SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return r[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: SOFT DELETE
  // ═════════════════════════════════════════════════════════════
  async deactivate(id: number, adminId: number) {
    const r = await this.dataSource.query(
      `UPDATE promotion_cms
       SET is_active = FALSE, updated_by_admin_id = $1
       WHERE id = $2 RETURNING id`,
      [adminId, id],
    );
    if (!r.length) throw new NotFoundException('Promotion CMS entry not found');
    return { message: 'Promotion CMS entry deactivated' };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST
  // ═════════════════════════════════════════════════════════════
  async list(q: ListPromotionCmsQueryDto) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (q.currency)               { where.push(`currency = $${i++}`);     params.push(q.currency); }
    if (q.isActive !== undefined) { where.push(`is_active = $${i++}`);    params.push(q.isActive); }
    if (q.tag)                    { where.push(`tags @> $${i++}::jsonb`); params.push(JSON.stringify([q.tag])); }
    if (q.promotionId)            { where.push(`promotion_id = $${i++}`); params.push(q.promotionId); }
    if (q.search) {
      where.push(`(title_en ILIKE $${i} OR title_bn ILIKE $${i})`);
      params.push(`%${q.search}%`);
      i++;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 200);
    const offset = (page - 1) * limit;

    const data = await this.dataSource.query(
      `SELECT pc.*,
              p.title  AS engine_title,
              p.code   AS engine_code,
              p.kind   AS engine_kind,
              p.is_active AS engine_is_active
       FROM promotion_cms pc
       LEFT JOIN promotions p ON p.id = pc.promotion_id
       ${whereSql}
       ORDER BY pc.sequence ASC, pc.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const totalRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM promotion_cms ${whereSql}`,
      params,
    );

    return { data, page, limit, total: totalRows[0].total };
  }

  async getOne(id: number) {
    const r = await this.dataSource.query(
      `SELECT pc.*,
              p.title  AS engine_title,
              p.code   AS engine_code,
              p.kind   AS engine_kind
       FROM promotion_cms pc
       LEFT JOIN promotions p ON p.id = pc.promotion_id
       WHERE pc.id = $1`,
      [id],
    );
    if (!r.length) throw new NotFoundException('Promotion CMS entry not found');
    return r[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: REORDER (drag-and-drop sequence assignment)
  // ═════════════════════════════════════════════════════════════
  async reorder(dto: ReorderPromotionCmsDto, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      for (const item of dto.items) {
        await qr.query(
          `UPDATE promotion_cms
           SET sequence = $1, updated_by_admin_id = $2
           WHERE id = $3`,
          [item.sequence, adminId, item.id],
        );
      }
      await qr.commitTransaction();
      return { message: 'Sequence updated', updated: dto.items.length };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: GUEST/USER BANNER LIST
  //   - For guests: only display_before_login = TRUE rows
  //   - For users:  only display_after_login  = TRUE rows + eligibility
  //                 evaluation against linked promotion
  // ═════════════════════════════════════════════════════════════
  async publicList(q: PublicPromotionCmsQueryDto, userId: number | null) {
    const params: any[] = [q.currency ?? 'BDT'];
    let i = 2;

    const visibilityCol = userId
      ? 'display_after_login = TRUE'
      : 'display_before_login = TRUE';

    let tagFilter = '';
    if (q.tag) {
      tagFilter = `AND pc.tags @> $${i++}::jsonb`;
      params.push(JSON.stringify([q.tag]));
    }

    const rows = await this.dataSource.query(
      `SELECT pc.id, pc.promotion_id, pc.currency, pc.sequence, pc.tags,
              pc.show_remaining_time, pc.allow_apply, pc.redirect_target,
              pc.non_eligible_display,
              pc.starts_at, pc.ends_at,
              pc.title_en, pc.description_en, pc.content_en,
              pc.banner_en_url, pc.small_banner_en_url,
              pc.title_bn, pc.description_bn, pc.content_bn,
              pc.banner_bn_url, pc.small_banner_bn_url,
              pc.button_show_with_title, pc.button_show_when_eligible,
              pc.button_show_in_promotions, pc.button_show_in_promo_center,
              pc.eligible_member_group_id,
              p.code AS promo_code, p.kind AS promo_kind,
              p.bonus_type, p.bonus_value, p.max_bonus, p.min_amount,
              p.starts_at AS promo_starts_at, p.ends_at AS promo_ends_at,
              p.is_active AS promo_is_active
       FROM promotion_cms pc
       LEFT JOIN promotions p ON p.id = pc.promotion_id
       WHERE pc.is_active = TRUE
         AND pc.currency = $1
         AND ${visibilityCol}
         AND (pc.starts_at IS NULL OR pc.starts_at <= NOW())
         AND (pc.ends_at   IS NULL OR pc.ends_at   >  NOW())
         ${tagFilter}
       ORDER BY pc.sequence ASC, pc.created_at DESC`,
      params,
    );

    // Compute eligibility per row when user is logged in
    const userGroups = userId
      ? (await this.dataSource.query(
          `SELECT group_id FROM member_group_users WHERE user_id = $1`,
          [userId],
        )).map((r: any) => Number(r.group_id))
      : [];

    const allGroupId = (await this.dataSource.query(
      `SELECT id FROM member_groups WHERE code = 'ALL' LIMIT 1`,
    ))[0]?.id ?? null;

    const enriched = rows.map((row: any) => {
      let eligible = true;
      const reasons: string[] = [];

      if (userId) {
        // Member-group gate
        if (row.eligible_member_group_id) {
          const gid = Number(row.eligible_member_group_id);
          if (gid !== Number(allGroupId) && !userGroups.includes(gid)) {
            eligible = false;
            reasons.push('MEMBER_GROUP');
          }
        }
        // Linked promotion must be active
        if (row.promotion_id && row.promo_is_active === false) {
          eligible = false;
          reasons.push('PROMO_INACTIVE');
        }
      } else {
        // Guests are never "eligible" to claim — but cards still render
        eligible = false;
        reasons.push('GUEST');
      }

      const renderMode = eligible
        ? 'NORMAL'
        : row.non_eligible_display; // GREY / HIDE / DISABLED

      return {
        ...row,
        eligible,
        ineligibility_reasons: reasons,
        render_mode: renderMode,
      };
    });

    // Apply HIDE filter server-side (don't ship hidden cards to client)
    return enriched.filter((r: any) => r.render_mode !== 'HIDE');
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: SINGLE PROMOTION DETAILS PAGE
  // ═════════════════════════════════════════════════════════════
  async publicGetOne(id: number, userId: number | null) {
    const rows = await this.dataSource.query(
      `SELECT pc.*,
              p.code AS promo_code, p.kind AS promo_kind,
              p.bonus_type, p.bonus_value, p.max_bonus, p.min_amount,
              p.apply_amount_min, p.rollover_multiplier,
              p.starts_at AS promo_starts_at, p.ends_at AS promo_ends_at,
              p.is_active AS promo_is_active
       FROM promotion_cms pc
       LEFT JOIN promotions p ON p.id = pc.promotion_id
       WHERE pc.id = $1 AND pc.is_active = TRUE`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Promotion not found');

    const row = rows[0];

    // Apply same visibility gate as list
    if (!userId && !row.display_before_login) {
      throw new NotFoundException('Promotion not found');
    }
    if (userId && !row.display_after_login) {
      throw new NotFoundException('Promotion not found');
    }

    return row;
  }
}
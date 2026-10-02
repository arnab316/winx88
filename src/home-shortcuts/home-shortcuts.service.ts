import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  assertLinkTarget,
  LINK_TARGET_TYPES,
  unwrapReturning,
  type LinkTargetType,
} from 'src/common/link-target';
import { MediaS3Service } from 'src/common/services/media-s3.service';

/** Shortcuts and promo banners share the same target semantics. */
export type ShortcutTargetType = LinkTargetType;
export type ShortcutBadge = 'LIVE' | 'NEW' | 'HOT';

export const SHORTCUT_TARGET_TYPES = LINK_TARGET_TYPES;
export const SHORTCUT_BADGES: ShortcutBadge[] = ['LIVE', 'NEW', 'HOT'];

export interface ShortcutInput {
  labelEn: string;
  labelBn?: string | null;
  badge?: ShortcutBadge | null;
  targetType: ShortcutTargetType;
  targetValue: string;
  requiresAuth?: boolean;
  sortOrder?: number;
  isActive?: boolean;
  iconUrl?: string | null;
}

@Injectable()
export class HomeShortcutsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly media: MediaS3Service,
  ) {}

  /* ───────────────────────────── Public ───────────────────────────── */

  /** Active shortcuts in display order — what the player home screen renders. */
  async listActive() {
    const rows = await this.dataSource.query(
      `SELECT id, label_en, label_bn, icon_url, badge, target_type, target_value,
              requires_auth, sort_order
         FROM public.home_shortcuts
        WHERE is_active
        ORDER BY sort_order ASC, id ASC`,
    );
    return { items: rows.map(this.toDto), total: rows.length };
  }

  /* ───────────────────────────── Admin ────────────────────────────── */

  async listAll() {
    const rows = await this.dataSource.query(
      `SELECT id, label_en, label_bn, icon_url, badge, target_type, target_value,
              requires_auth, sort_order, is_active, created_at, updated_at
         FROM public.home_shortcuts
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

  async create(input: ShortcutInput, icon?: Express.Multer.File) {
    this.assertTarget(input.targetType, input.targetValue);

    const iconUrl = icon
      ? await this.media.uploadImage(icon, 'home-shortcuts')
      : (input.iconUrl ?? null);

    const rows = await this.dataSource.query(
      `INSERT INTO public.home_shortcuts
         (label_en, label_bn, icon_url, badge, target_type, target_value,
          requires_auth, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               COALESCE($8, (SELECT COALESCE(MAX(sort_order),0)+10 FROM public.home_shortcuts)),
               COALESCE($9,true))
       RETURNING *`,
      [
        input.labelEn,
        input.labelBn ?? null,
        iconUrl,
        input.badge ?? null,
        input.targetType,
        input.targetValue,
        input.requiresAuth ?? false,
        input.sortOrder ?? null,
        input.isActive ?? null,
      ],
    );
    return this.toDto(rows[0]);
  }

  async update(id: number, input: Partial<ShortcutInput>, icon?: Express.Multer.File) {
    const existing = await this.dataSource.query(
      `SELECT * FROM public.home_shortcuts WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Shortcut not found');

    // A partial update can change the type, the value, or both — validate the
    // combination that will actually be stored, not just what was sent.
    const targetType = (input.targetType ?? existing[0].target_type) as ShortcutTargetType;
    const targetValue = input.targetValue ?? existing[0].target_value;
    this.assertTarget(targetType, targetValue);

    const iconUrl = icon
      ? await this.media.uploadImage(icon, 'home-shortcuts')
      : input.iconUrl;

    const rows = unwrapReturning(
      await this.dataSource.query(
        `UPDATE public.home_shortcuts SET
           label_en      = COALESCE($2, label_en),
           label_bn      = COALESCE($3, label_bn),
           icon_url      = COALESCE($4, icon_url),
           badge         = CASE WHEN $5::text = '__CLEAR__' THEN NULL
                                ELSE COALESCE($5, badge) END,
           target_type   = COALESCE($6, target_type),
           target_value  = COALESCE($7, target_value),
           requires_auth = COALESCE($8, requires_auth),
           sort_order    = COALESCE($9, sort_order),
           is_active     = COALESCE($10, is_active),
           updated_at    = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          input.labelEn ?? null,
          input.labelBn ?? null,
          iconUrl ?? null,
          input.badge === null ? '__CLEAR__' : (input.badge ?? null),
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
        `DELETE FROM public.home_shortcuts WHERE id = $1 RETURNING id`,
        [id],
      ),
    );
    if (!rows.length) throw new NotFoundException('Shortcut not found');
    return { id, deleted: true };
  }

  /** Bulk reorder from a drag-and-drop list: ids in their new display order. */
  async reorder(ids: number[]) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException('ids must be a non-empty array');
    }
    await this.dataSource.query(
      `UPDATE public.home_shortcuts AS s
          SET sort_order = v.ord * 10, updated_at = NOW()
         FROM (SELECT UNNEST($1::int[]) AS id,
                      GENERATE_SERIES(1, array_length($1::int[], 1)) AS ord) AS v
        WHERE s.id = v.id`,
      [ids],
    );
    return this.listAll();
  }

  /* ──────────────────────────── Helpers ───────────────────────────── */

  /** Shared with promo banners — see src/common/link-target.ts. */
  private assertTarget(type: ShortcutTargetType, value: string) {
    assertLinkTarget(type, value);
  }

  private toDto = (r: any) => ({
    id: r.id,
    labelEn: r.label_en,
    labelBn: r.label_bn ?? null,
    iconUrl: r.icon_url ?? null,
    badge: (r.badge ?? null) as ShortcutBadge | null,
    targetType: r.target_type as ShortcutTargetType,
    targetValue: r.target_value,
    requiresAuth: r.requires_auth,
    sortOrder: r.sort_order,
  });
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { unwrapReturning } from 'src/common/link-target';

/**
 * The category chips on the player home.
 *
 * `source` decides where a chip's games come from — the chips never all read
 * the same place:
 *
 *   ALL            no filter, the default chip
 *   SLOT_PROVIDER  Palace slot providers (GET /slot/providers)
 *   OROPLAY_GROUP  a key of GET /oroplay/vendors/grouped
 *   CATALOG        a casino_games.type — how Nexus-fed categories surface
 *   LINK           navigate instead of opening a picker
 */
export const CATEGORY_SOURCES = [
  'ALL',
  'OROPLAY_GROUP',
  'SLOT_PROVIDER',
  'CATALOG',
  'LINK',
] as const;
export type CategorySource = (typeof CATEGORY_SOURCES)[number];

export interface CategoryInput {
  key: string;
  labelEn: string;
  labelBn?: string | null;
  iconUrl?: string | null;
  source: CategorySource;
  value?: string;
  requiresAuth?: boolean;
  sortOrder?: number;
  isActive?: boolean;
}

@Injectable()
export class GameCategoriesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private readonly SELECT = `
    SELECT id, key, label_en AS "labelEn", label_bn AS "labelBn",
           icon_url AS "iconUrl", source, value,
           requires_auth AS "requiresAuth", sort_order AS "sortOrder",
           is_active AS "isActive", created_at AS "createdAt"
      FROM game_categories`;

  /** What the player panel renders. */
  listActive() {
    return this.dataSource.query(
      `${this.SELECT} WHERE is_active ORDER BY sort_order, id`,
    );
  }

  listAll() {
    return this.dataSource.query(`${this.SELECT} ORDER BY sort_order, id`);
  }

  private validate(input: Partial<CategoryInput>, requireAll: boolean) {
    if (requireAll || input.source !== undefined) {
      if (!CATEGORY_SOURCES.includes(input.source as CategorySource)) {
        throw new BadRequestException(
          `source must be one of ${CATEGORY_SOURCES.join(', ')}`,
        );
      }
    }
    // Every source except ALL is meaningless without something to point at —
    // a chip with no value would silently open an empty picker.
    const source = input.source as CategorySource;
    if (source && source !== 'ALL' && requireAll && !input.value?.trim()) {
      throw new BadRequestException(`value is required when source is ${source}`);
    }
    if (input.key !== undefined && !/^[a-z0-9_-]{2,40}$/.test(input.key)) {
      throw new BadRequestException(
        'key must be 2-40 characters of lowercase letters, digits, _ or -',
      );
    }
  }

  async create(input: CategoryInput) {
    this.validate(input, true);
    const [row] = await this.dataSource.query(
      `INSERT INTO game_categories
         (key, label_en, label_bn, icon_url, source, value, requires_auth, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        input.key.trim(),
        input.labelEn.trim(),
        input.labelBn?.trim() || null,
        input.iconUrl?.trim() || null,
        input.source,
        input.value?.trim() ?? '',
        input.requiresAuth ?? false,
        input.sortOrder ?? 0,
        input.isActive ?? true,
      ],
    ).catch((e: any) => {
      if (e?.code === '23505') throw new BadRequestException('That key is already used');
      throw e;
    });
    return this.byId(row.id);
  }

  async update(id: number, input: Partial<CategoryInput>) {
    this.validate(input, false);
    const sets: string[] = [];
    const params: any[] = [];
    const set = (col: string, v: any) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.key !== undefined) set('key', input.key.trim());
    if (input.labelEn !== undefined) set('label_en', input.labelEn.trim());
    if (input.labelBn !== undefined) set('label_bn', input.labelBn?.trim() || null);
    if (input.iconUrl !== undefined) set('icon_url', input.iconUrl?.trim() || null);
    if (input.source !== undefined) set('source', input.source);
    if (input.value !== undefined) set('value', input.value?.trim() ?? '');
    if (input.requiresAuth !== undefined) set('requires_auth', input.requiresAuth);
    if (input.sortOrder !== undefined) set('sort_order', input.sortOrder);
    if (input.isActive !== undefined) set('is_active', input.isActive);
    if (!sets.length) return this.byId(id);

    params.push(id);
    const result = await this.dataSource
      .query(
        `UPDATE game_categories SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${params.length} RETURNING id`,
        params,
      )
      .catch((e: any) => {
        if (e?.code === '23505') throw new BadRequestException('That key is already used');
        throw e;
      });
    // UPDATE ... RETURNING hands back [rows, count], not rows.
    if (!unwrapReturning(result).length) throw new NotFoundException('Category not found');
    return this.byId(id);
  }

  async remove(id: number) {
    const result = await this.dataSource.query(
      `DELETE FROM game_categories WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!unwrapReturning(result).length) throw new NotFoundException('Category not found');
    return { success: true };
  }

  /** Persist a drag-and-drop ordering in one statement. */
  async reorder(ids: number[]) {
    if (!Array.isArray(ids) || !ids.length) {
      throw new BadRequestException('ids must be a non-empty array');
    }
    await this.dataSource.query(
      `UPDATE game_categories AS c SET sort_order = v.ord, updated_at = NOW()
         FROM (VALUES ${ids.map((_, i) => `($${i + 1}::int, ${(i + 1) * 10})`).join(',')})
              AS v(id, ord)
        WHERE c.id = v.id`,
      ids.map(Number),
    );
    return this.listAll();
  }

  private async byId(id: number) {
    const [row] = await this.dataSource.query(`${this.SELECT} WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('Category not found');
    return row;
  }
}

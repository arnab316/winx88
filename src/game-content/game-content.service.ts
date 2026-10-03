import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { unwrapReturning } from 'src/common/link-target';
import { MediaS3Service } from 'src/common/services/media-s3.service';
import { GAME_KINDS, type GameKind } from 'src/game-library/game-library.service';

export const GAME_BADGES = ['HOT', 'NEW', 'POPULAR'] as const;
export type GameBadge = (typeof GAME_BADGES)[number];

/** A stat chip under the game title. Free-text: providers give us nothing. */
export interface GameFeature {
  labelEn: string;
  labelBn?: string | null;
}

export interface GameContentInput {
  kind: GameKind;
  providerRef: string;
  gameCode: string;
  displayName?: string | null;
  providerName?: string | null;
  coverImage?: string | null;
  aboutEn?: string | null;
  aboutBn?: string | null;
  features?: GameFeature[];
  screenshots?: string[];
  badges?: GameBadge[];
  sortOrder?: number;
  isActive?: boolean;
}

export type ListSort = 'ORDER' | 'NAME' | 'NEWEST';

export interface ListQuery {
  badge?: GameBadge;
  kind?: GameKind;
  q?: string;
  sort?: ListSort;
  page?: number;
  limit?: number;
}

@Injectable()
export class GameContentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly media: MediaS3Service,
  ) {}

  /* ───────────────────────────── Public ───────────────────────────── */

  /**
   * A collection screen (Hot Games is `badge=HOT`).
   *
   * Name and artwork fall back through admin override -> catalog -> raw code.
   * The catalog join is on `game_symbol` for slots — `game_code` is empty on
   * Palace rows, so joining on it matches nothing.
   *
   * `userId` is optional; when present each row carries `isFavourite` so the
   * grid can paint hearts without a second round trip.
   */
  async listPublic(q: ListQuery, userId?: number) {
    const page = Math.max(Number(q.page) || 1, 1);
    const limit = Math.min(Math.max(Number(q.limit) || 24, 1), 60);
    const offset = (page - 1) * limit;

    const where: string[] = ['gc.is_active'];
    const params: any[] = [];
    let i = 1;

    if (q.badge) {
      where.push(`gc.badges ? $${i++}`);
      params.push(q.badge);
    }
    if (q.kind) {
      where.push(`gc.kind = $${i++}`);
      params.push(q.kind);
    }
    if (q.q?.trim()) {
      // Search the resolved name, so a catalog-only title is still findable.
      where.push(
        `COALESCE(gc.display_name, cg.name, gc.game_code) ILIKE $${i++}`,
      );
      params.push(`%${q.q.trim()}%`);
    }

    const favSelect = userId ? `(f.id IS NOT NULL)` : `false`;
    const favJoin = userId
      ? `LEFT JOIN public.user_favourite_games f
           ON f.user_id = $${i} AND f.kind = gc.kind
          AND f.provider_ref = gc.provider_ref AND f.game_code = gc.game_code`
      : '';
    if (userId) params.push(userId);

    const orderBy =
      q.sort === 'NAME'
        ? `COALESCE(gc.display_name, cg.name, gc.game_code) ASC`
        : q.sort === 'NEWEST'
          ? `gc.created_at DESC`
          : `gc.sort_order ASC, gc.id ASC`;

    const from = `
      FROM public.game_content gc
      LEFT JOIN LATERAL (
        SELECT c.name, c.image, c.provider
          FROM public.casino_games c
         WHERE (gc.kind = 'SLOT'  AND c.game_symbol = gc.game_code
                                  AND c.provider_id::text = gc.provider_ref)
            OR (gc.kind <> 'SLOT' AND c.game_code   = gc.game_code
                                  AND c.vendor_code = gc.provider_ref)
         LIMIT 1
      ) cg ON TRUE
      ${favJoin}
      WHERE ${where.join(' AND ')}
    `;

    const rows = await this.dataSource.query(
      `SELECT gc.id, gc.kind, gc.provider_ref, gc.game_code, gc.badges, gc.sort_order,
              COALESCE(gc.display_name, cg.name, gc.game_code) AS game_name,
              COALESCE(gc.cover_image, cg.image)               AS game_image,
              COALESCE(gc.provider_name, cg.provider)          AS provider_name,
              ${favSelect}                                     AS is_favourite
       ${from}
       ORDER BY ${orderBy}
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const countRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total ${from}`,
      params,
    );
    const total = countRows[0]?.total ?? 0;

    return {
      items: rows.map((r: any, idx: number) => ({
        ...this.publicDto(r),
        // Position in the curated order — the mockup's 1/2/3 rank badge.
        rank: offset + idx + 1,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /** Full detail for the game page: about, features, screenshots, badges. */
  async getDetail(kind: GameKind, providerRef: string, gameCode: string, userId?: number) {
    const params: any[] = [kind, providerRef, gameCode];
    const favSelect = userId ? `(f.id IS NOT NULL)` : `false`;
    const favJoin = userId
      ? `LEFT JOIN public.user_favourite_games f
           ON f.user_id = $4 AND f.kind = gc.kind
          AND f.provider_ref = gc.provider_ref AND f.game_code = gc.game_code`
      : '';
    if (userId) params.push(userId);

    const rows = await this.dataSource.query(
      `SELECT gc.*,
              COALESCE(gc.display_name, cg.name, gc.game_code) AS game_name,
              COALESCE(gc.cover_image, cg.image)               AS game_image,
              COALESCE(gc.provider_name, cg.provider)          AS resolved_provider,
              ${favSelect}                                     AS is_favourite
         FROM public.game_content gc
         LEFT JOIN LATERAL (
           SELECT c.name, c.image, c.provider
             FROM public.casino_games c
            WHERE (gc.kind = 'SLOT'  AND c.game_symbol = gc.game_code
                                     AND c.provider_id::text = gc.provider_ref)
               OR (gc.kind <> 'SLOT' AND c.game_code   = gc.game_code
                                     AND c.vendor_code = gc.provider_ref)
            LIMIT 1
         ) cg ON TRUE
         ${favJoin}
        WHERE gc.kind = $1 AND gc.provider_ref = $2 AND gc.game_code = $3
          AND gc.is_active`,
      params,
    );
    if (!rows.length) throw new NotFoundException('Game not found');

    const r = rows[0];
    return {
      ...this.publicDto(r),
      aboutEn: r.about_en ?? null,
      aboutBn: r.about_bn ?? null,
      features: this.asArray(r.features),
      screenshots: this.asArray(r.screenshots),
    };
  }

  /**
   * "Recommended for you" / Similar games.
   *
   * `casino_games.related_games` is empty for every row, so similarity is
   * computed: same provider first, then anything else sharing a badge.
   */
  async getSimilar(kind: GameKind, providerRef: string, gameCode: string, limit = 10) {
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 30);
    const rows = await this.dataSource.query(
      `SELECT gc.id, gc.kind, gc.provider_ref, gc.game_code, gc.badges, gc.sort_order,
              COALESCE(gc.display_name, cg.name, gc.game_code) AS game_name,
              COALESCE(gc.cover_image, cg.image)               AS game_image,
              COALESCE(gc.provider_name, cg.provider)          AS provider_name,
              false                                            AS is_favourite,
              (gc.provider_ref = $2 AND gc.kind = $1)           AS same_provider
         FROM public.game_content gc
         LEFT JOIN LATERAL (
           SELECT c.name, c.image, c.provider
             FROM public.casino_games c
            WHERE (gc.kind = 'SLOT'  AND c.game_symbol = gc.game_code
                                     AND c.provider_id::text = gc.provider_ref)
               OR (gc.kind <> 'SLOT' AND c.game_code   = gc.game_code
                                     AND c.vendor_code = gc.provider_ref)
            LIMIT 1
         ) cg ON TRUE
        WHERE gc.is_active
          AND NOT (gc.kind = $1 AND gc.provider_ref = $2 AND gc.game_code = $3)
        ORDER BY same_provider DESC, gc.sort_order ASC, gc.id ASC
        LIMIT $4`,
      [kind, providerRef, gameCode, safeLimit],
    );
    return { items: rows.map(this.publicDto), total: rows.length };
  }

  /**
   * Game picker for the admin form: searches the catalog so an admin can add a
   * game without hand-typing its code. OroPlay games are not in the catalog, so
   * those still need manual entry — the admin UI says so.
   */
  async searchCatalog(q: string, limit = 20) {
    const term = (q ?? '').trim();
    if (term.length < 2) return { items: [], total: 0 };
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);

    const rows = await this.dataSource.query(
      `SELECT c.name, c.image, c.provider, c.provider_id, c.game_symbol,
              c.game_code, c.vendor_code, c.aggregator
         FROM public.casino_games c
        WHERE c.name ILIKE $1
        ORDER BY c.name ASC
        LIMIT $2`,
      [`%${term}%`, safeLimit],
    );

    return {
      items: rows.map((r: any) => {
        const isSlot = r.provider_id !== null && !!r.game_symbol;
        return {
          kind: (isSlot ? 'SLOT' : r.aggregator === 'NEXUS' ? 'NEXUS' : 'ORO') as GameKind,
          providerRef: isSlot ? String(r.provider_id) : (r.vendor_code ?? ''),
          gameCode: isSlot ? r.game_symbol : r.game_code,
          gameName: r.name,
          gameImage: r.image ?? null,
          providerName: r.provider ?? null,
        };
      }),
      total: rows.length,
    };
  }

  /* ───────────────────────────── Admin ────────────────────────────── */

  async listAll(q: { q?: string; page?: number; limit?: number }) {
    const page = Math.max(Number(q.page) || 1, 1);
    const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 100);
    const offset = (page - 1) * limit;

    const where: string[] = ['TRUE'];
    const params: any[] = [];
    let i = 1;
    if (q.q?.trim()) {
      where.push(`(COALESCE(display_name,'') ILIKE $${i} OR game_code ILIKE $${i})`);
      params.push(`%${q.q.trim()}%`);
      i++;
    }

    const rows = await this.dataSource.query(
      `SELECT * FROM public.game_content
        WHERE ${where.join(' AND ')}
        ORDER BY sort_order ASC, id ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const countRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM public.game_content WHERE ${where.join(' AND ')}`,
      params,
    );

    return {
      items: rows.map(this.adminDto),
      page,
      limit,
      total: countRows[0]?.total ?? 0,
    };
  }

  /** Upsert on the identity triple, so re-adding a game edits it. */
  async upsert(input: GameContentInput, cover?: Express.Multer.File) {
    const kind = String(input.kind || '').toUpperCase() as GameKind;
    if (!GAME_KINDS.includes(kind)) {
      throw new BadRequestException(`kind must be one of ${GAME_KINDS.join(', ')}`);
    }
    const providerRef = String(input.providerRef ?? '').trim();
    const gameCode = String(input.gameCode ?? '').trim();
    if (!providerRef) throw new BadRequestException('providerRef is required');
    if (!gameCode) throw new BadRequestException('gameCode is required');

    const coverImage = cover
      ? await this.media.uploadImage(cover, 'game-content')
      : (input.coverImage ?? null);

    const rows = await this.dataSource.query(
      `INSERT INTO public.game_content
         (kind, provider_ref, game_code, display_name, provider_name, cover_image,
          about_en, about_bn, features, screenshots, badges, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               COALESCE($9::jsonb,'[]'::jsonb),
               COALESCE($10::jsonb,'[]'::jsonb),
               COALESCE($11::jsonb,'[]'::jsonb),
               COALESCE($12, (SELECT COALESCE(MAX(sort_order),0)+10 FROM public.game_content)),
               COALESCE($13,true))
       ON CONFLICT (kind, provider_ref, game_code) DO UPDATE SET
         display_name  = COALESCE(EXCLUDED.display_name,  game_content.display_name),
         provider_name = COALESCE(EXCLUDED.provider_name, game_content.provider_name),
         cover_image   = COALESCE(EXCLUDED.cover_image,   game_content.cover_image),
         about_en      = COALESCE(EXCLUDED.about_en,      game_content.about_en),
         about_bn      = COALESCE(EXCLUDED.about_bn,      game_content.about_bn),
         features      = COALESCE(EXCLUDED.features,      game_content.features),
         screenshots   = COALESCE(EXCLUDED.screenshots,   game_content.screenshots),
         badges        = COALESCE(EXCLUDED.badges,        game_content.badges),
         sort_order    = COALESCE(EXCLUDED.sort_order,    game_content.sort_order),
         is_active     = COALESCE(EXCLUDED.is_active,     game_content.is_active),
         updated_at    = NOW()
       RETURNING *`,
      [
        kind,
        providerRef,
        gameCode,
        input.displayName ?? null,
        input.providerName ?? null,
        coverImage,
        input.aboutEn ?? null,
        input.aboutBn ?? null,
        input.features ? JSON.stringify(input.features) : null,
        input.screenshots ? JSON.stringify(input.screenshots) : null,
        input.badges ? JSON.stringify(input.badges) : null,
        input.sortOrder ?? null,
        input.isActive ?? null,
      ],
    );
    return this.adminDto(rows[0]);
  }

  async update(id: number, input: Partial<GameContentInput>, cover?: Express.Multer.File) {
    const existing = await this.dataSource.query(
      `SELECT id FROM public.game_content WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Game content not found');

    const coverImage = cover
      ? await this.media.uploadImage(cover, 'game-content')
      : input.coverImage;

    const rows = unwrapReturning(
      await this.dataSource.query(
        `UPDATE public.game_content SET
           display_name  = COALESCE($2,  display_name),
           provider_name = COALESCE($3,  provider_name),
           cover_image   = COALESCE($4,  cover_image),
           about_en      = COALESCE($5,  about_en),
           about_bn      = COALESCE($6,  about_bn),
           features      = COALESCE($7::jsonb,  features),
           screenshots   = COALESCE($8::jsonb,  screenshots),
           badges        = COALESCE($9::jsonb,  badges),
           sort_order    = COALESCE($10, sort_order),
           is_active     = COALESCE($11, is_active),
           updated_at    = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          input.displayName ?? null,
          input.providerName ?? null,
          coverImage ?? null,
          input.aboutEn ?? null,
          input.aboutBn ?? null,
          input.features ? JSON.stringify(input.features) : null,
          input.screenshots ? JSON.stringify(input.screenshots) : null,
          input.badges ? JSON.stringify(input.badges) : null,
          input.sortOrder ?? null,
          input.isActive ?? null,
        ],
      ),
    );
    return this.adminDto(rows[0]);
  }

  async remove(id: number) {
    const rows = unwrapReturning(
      await this.dataSource.query(
        `DELETE FROM public.game_content WHERE id = $1 RETURNING id`,
        [id],
      ),
    );
    if (!rows.length) throw new NotFoundException('Game content not found');
    return { id, deleted: true };
  }

  async reorder(ids: number[]) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException('ids must be a non-empty array');
    }
    await this.dataSource.query(
      `UPDATE public.game_content AS g
          SET sort_order = v.ord * 10, updated_at = NOW()
         FROM (SELECT UNNEST($1::int[]) AS id,
                      GENERATE_SERIES(1, array_length($1::int[], 1)) AS ord) AS v
        WHERE g.id = v.id`,
      [ids],
    );
    return { reordered: ids.length };
  }

  /** Uploads one screenshot and returns its URL for the client to append. */
  async uploadScreenshot(file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    const url = await this.media.uploadImage(file, 'game-content/screenshots');
    return { url };
  }

  /* ──────────────────────────── Helpers ───────────────────────────── */

  private asArray(v: any): any[] {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  private publicDto = (r: any) => ({
    kind: r.kind as GameKind,
    providerRef: r.provider_ref,
    gameCode: r.game_code,
    gameName: r.game_name,
    gameImage: r.game_image ?? null,
    providerName: r.provider_name ?? r.resolved_provider ?? null,
    badges: this.asArray(r.badges) as GameBadge[],
    isFavourite: Boolean(r.is_favourite),
    launch: {
      kind: r.kind as GameKind,
      providerRef: r.provider_ref,
      gameCode: r.game_code,
    },
  });

  private adminDto = (r: any) => ({
    id: r.id,
    kind: r.kind as GameKind,
    providerRef: r.provider_ref,
    gameCode: r.game_code,
    displayName: r.display_name ?? null,
    providerName: r.provider_name ?? null,
    coverImage: r.cover_image ?? null,
    aboutEn: r.about_en ?? null,
    aboutBn: r.about_bn ?? null,
    features: this.asArray(r.features) as GameFeature[],
    screenshots: this.asArray(r.screenshots) as string[],
    badges: this.asArray(r.badges) as GameBadge[],
    sortOrder: r.sort_order,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

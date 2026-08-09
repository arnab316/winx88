// src/channels/channels.service.ts
//
// Marketing channel tracking for third-party media buyers. Read-only aggregates
// over clicks, registrations, first-time deposits and deposits, grouped by
// campaign channel. Raw SQL against the schema created in migration
// 2050000000000, matching the style used by src/reports/reports.service.ts.
import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import {
  ChannelStatsQueryDto,
  CreateVendorDto,
  UpdateVendorDto,
  CreateApiKeyDto,
  CreateChannelDto,
  UpdateChannelDto,
  ChannelListQueryDto,
  UnknownClickQueryDto,
} from './dto/channels.dto';

/** A daily pull wider than this is refused — it is the one query that can hurt. */
const MAX_RANGE_DAYS = 92;

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(private dataSource: DataSource) {}

  // ═════════════════════════════════════════════════════════════
  // SHARED HELPERS
  // ═════════════════════════════════════════════════════════════

  /**
   * Inclusive lower / exclusive upper bounds, matching reports.service.ts:
   * `dateTo` is an inclusive calendar date, so the upper bound is +1 day. NULL
   * on either side means unbounded.
   */
  private bounds(dateFrom?: string, dateTo?: string) {
    const start = dateFrom ? dateFrom.slice(0, 10) : null;
    const end = dateTo
      ? new Date(new Date(dateTo.slice(0, 10) + 'T00:00:00Z').getTime() + 86_400_000)
          .toISOString()
          .slice(0, 10)
      : null;
    return { start, end };
  }

  /** Codes are matched case-insensitively; the canonical form is lowercase. */
  private normalizeCode(code: string): string {
    return String(code ?? '').trim().toLowerCase().slice(0, 64);
  }

  /**
   * TypeORM returns `[rows, affectedCount]` from UPDATE/DELETE ... RETURNING
   * but a plain rows array from INSERT/SELECT. Taking `result[0]` blindly on an
   * UPDATE yields the rows ARRAY rather than the first row, which silently
   * turns a "no rows matched" case into an apparent success. Always unwrap
   * through here. Same idiom as rbac.service.ts.
   */
  private firstRow(res: any): any | undefined {
    const rows = Array.isArray(res?.[0]) ? res[0] : res;
    return Array.isArray(rows) ? rows[0] : undefined;
  }

  /** Where the /c/:code links must point — the API host, not the public site. */
  private trackingBase(): string {
    return (process.env.APP_BASE_URL ?? 'https://winx-88.com').replace(/\/+$/, '');
  }

  private trackingUrl(code: string): string {
    return `${this.trackingBase()}/c/${encodeURIComponent(code)}`;
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: record a channel click (best-effort, never throws)
  //   Mirrors AffiliateService.recordClick — a tracking failure must never
  //   break the redirect a paying advertiser sent the visitor through.
  // ═════════════════════════════════════════════════════════════
  async recordChannelClick(
    code: string,
    meta: {
      ip?: string;
      userAgent?: string | string[];
      referer?: string | string[];
      landingPath?: string;
      subId?: string;
      source?: 'REDIRECT' | 'PARAM';
      fbclid?: string;
      fbp?: string;
    } = {},
  ): Promise<{
    ok: boolean;
    clickUid?: string;
    landingPath?: string;
    pixelId?: string | null;
  }> {
    const ch = this.normalizeCode(code);
    if (!ch) return { ok: false };

    try {
      // An unregistered code is still logged (is_unknown) — a typo in a live
      // campaign must surface in the unknown feed, never silently vanish.
      const rows = await this.dataSource.query(
        `SELECT id, vendor_id, landing_path, is_active, pixel_id
           FROM marketing_channels WHERE code = $1 LIMIT 1`,
        [ch],
      );
      const channel = rows[0] ?? null;

      const first = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v) ?? null;
      const clickUid = crypto.randomUUID();

      await this.dataSource.query(
        `INSERT INTO marketing_clicks
           (click_uid, channel_code, channel_id, vendor_id, is_unknown,
            sub_id, ip, user_agent, referer, landing_path, fbclid, fbc, fbp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          clickUid,
          ch,
          channel?.id ?? null,
          channel?.vendor_id ?? null,
          !channel,
          meta.subId ?? null,
          meta.ip ?? null,
          first(meta.userAgent),
          first(meta.referer),
          meta.landingPath ?? null,
          meta.fbclid ?? null,
          this.toFbc(meta.fbclid),
          meta.fbp ?? null,
        ],
      );

      return {
        ok: true,
        clickUid,
        landingPath: channel?.landing_path ?? '/register',
        pixelId: channel?.pixel_id ?? null,
      };
    } catch (e: any) {
      // Best-effort: swallow so the caller can still redirect.
      this.logger.warn(`recordChannelClick failed for "${ch}": ${e?.message}`);
      return { ok: false };
    }
  }

  /**
   * Facebook's click id in the cookie format Meta's Conversions API expects:
   * `fb.<subdomainIndex>.<creationTimeMs>.<fbclid>`.
   *
   * Derived and stored at click time because the timestamp must be when the
   * click happened — recomputing it later (at deposit approval, possibly days
   * on) would produce a value Meta cannot match, quietly degrading attribution.
   */
  private toFbc(fbclid?: string): string | null {
    const id = (fbclid ?? '').trim();
    if (!id) return null;
    return `fb.1.${Date.now()}.${id}`.slice(0, 128);
  }

  // ═════════════════════════════════════════════════════════════
  // VENDOR API (scoped by ApiKeyGuard → req.vendor.id)
  // ═════════════════════════════════════════════════════════════

  async getVendorChannels(vendorId: number) {
    const rows = await this.dataSource.query(
      `SELECT code, name, platform, is_active, created_at
         FROM marketing_channels
        WHERE vendor_id = $1
        ORDER BY code ASC`,
      [vendorId],
    );
    return {
      success: true,
      data: rows.map((r: any) => ({
        code: r.code,
        name: r.name,
        platform: r.platform,
        isActive: r.is_active,
        createdAt: r.created_at,
        trackingUrl: this.trackingUrl(r.code),
      })),
    };
  }

  /**
   * The vendor's own numbers. Scoping is enforced by the SQL itself —
   * `marketing_channels` is the driving table filtered on the bound vendor id,
   * so there is no code path that can surface another vendor's channels.
   *
   * Only aggregates are returned: never an IP, user agent, username or user id.
   */
  async getVendorStats(vendorId: number, q: ChannelStatsQueryDto) {
    const { start, end } = this.bounds(q.dateFrom, q.dateTo);
    const channel = q.channel ? this.normalizeCode(q.channel) : null;
    const daily = q.granularity === 'day';

    if (daily) {
      if (!start || !end) {
        throw new BadRequestException(
          'dateFrom and dateTo are required when granularity=day',
        );
      }
      const days = Math.round(
        (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
      );
      if (days > MAX_RANGE_DAYS) {
        throw new BadRequestException(
          `Date range too wide for granularity=day (${days} days, max ${MAX_RANGE_DAYS}). Narrow the range or use granularity=total.`,
        );
      }
    }

    // Per-metric lateral bounds. For a daily pull each metric is clamped to the
    // generated day instead of the whole range.
    const lo = daily ? `g.day` : `$2::timestamptz`;
    const hi = daily ? `g.day + INTERVAL '1 day'` : `$3::timestamptz`;
    const bounded = (col: string) =>
      daily
        ? `${col} >= ${lo} AND ${col} < ${hi}`
        : `($2::timestamptz IS NULL OR ${col} >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR ${col} <  $3::timestamptz)`;

    // Formatted in SQL as a plain YYYY-MM-DD string. A bare ::date comes back
    // as a Date and serializes to a UTC instant, so a non-UTC server would
    // report the previous calendar day to the vendor.
    const dayCol = daily ? `to_char(g.day, 'YYYY-MM-DD') AS date,` : '';
    const daySource = daily
      ? `CROSS JOIN generate_series($2::date, $3::date - INTERVAL '1 day', INTERVAL '1 day') AS g(day)`
      : '';
    const dayOrder = daily ? `, g.day ASC` : '';

    const sql = `
      SELECT
        ch.code                                   AS channel,
        ch.name                                   AS channel_name,
        ch.platform,
        ${dayCol}
        COALESCE(clk.c, 0)                        AS clicks,
        COALESCE(reg.c, 0)                        AS registrations,
        COALESCE(ftd.c, 0)                        AS ftds,
        COALESCE(ftd.amt, 0)                      AS ftd_amount,
        COALESCE(dep.c, 0)                        AS deposit_count,
        COALESCE(dep.amt, 0)                      AS deposit_total
      FROM marketing_channels ch
      ${daySource}
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS c
          FROM marketing_clicks k
         WHERE k.channel_id = ch.id AND ${bounded('k.created_at')}
      ) clk ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS c
          FROM user_channel_attribution a
         WHERE a.channel_id = ch.id AND ${bounded('a.attributed_at')}
      ) reg ON TRUE
      LEFT JOIN LATERAL (
        -- FTD = the user's FIRST-EVER approved deposit, counted into this
        -- period only if that first approval falls inside it. Deliberately not
        -- "first deposit in window", which would re-count a returning player.
        SELECT COUNT(*)::int AS c, COALESCE(SUM(f.ftd_amount), 0) AS amt
          FROM user_channel_attribution a
          JOIN LATERAL (
            SELECT d.decided_at AS ftd_at, d.amount AS ftd_amount
              FROM deposits d
             WHERE d.user_id = a.user_id AND d.status = 'APPROVED'
             ORDER BY d.decided_at ASC
             LIMIT 1
          ) f ON TRUE
         WHERE a.channel_id = ch.id AND ${bounded('f.ftd_at')}
      ) ftd ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS c, COALESCE(SUM(d.amount), 0) AS amt
          FROM user_channel_attribution a
          JOIN deposits d ON d.user_id = a.user_id AND d.status = 'APPROVED'
         WHERE a.channel_id = ch.id AND ${bounded('d.decided_at')}
      ) dep ON TRUE
      WHERE ch.vendor_id = $1
        AND ($4::text IS NULL OR ch.code = $4)
      ORDER BY ch.code ASC${dayOrder}
    `;

    const rows = await this.dataSource.query(sql, [vendorId, start, end, channel]);

    // Tracking started at go-live; anything earlier legitimately reads zero.
    const [meta] = await this.dataSource.query(
      `SELECT MIN(k.created_at) AS since
         FROM marketing_clicks k
         JOIN marketing_channels ch ON ch.id = k.channel_id
        WHERE ch.vendor_id = $1`,
      [vendorId],
    );

    const n = (v: any) => Number(v ?? 0);
    return {
      success: true,
      granularity: q.granularity ?? 'total',
      dateFrom: start,
      dateTo: q.dateTo ?? null,
      trackingSince: meta?.since ?? null,
      data: rows.map((r: any) => ({
        channel: r.channel,
        channelName: r.channel_name,
        platform: r.platform,
        ...(daily ? { date: r.date } : {}),
        clicks: n(r.clicks),
        registrations: n(r.registrations),
        ftds: n(r.ftds),
        ftdAmount: n(r.ftd_amount),
        depositCount: n(r.deposit_count),
        depositTotal: n(r.deposit_total),
      })),
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: VENDORS
  // ═════════════════════════════════════════════════════════════

  async listVendors() {
    const rows = await this.dataSource.query(
      `SELECT v.id, v.name, v.contact_email, v.status, v.notes, v.created_at,
              (SELECT COUNT(*)::int FROM marketing_channels c WHERE c.vendor_id = v.id) AS channel_count,
              (SELECT COUNT(*)::int FROM marketing_vendor_api_keys k
                WHERE k.vendor_id = v.id AND k.status = 'ACTIVE') AS active_keys
         FROM marketing_vendors v
        ORDER BY v.created_at DESC`,
    );
    return { success: true, data: rows.map((r: any) => ({ ...r, id: Number(r.id) })) };
  }

  async createVendor(dto: CreateVendorDto, adminId: number) {
    const [row] = await this.dataSource.query(
      `INSERT INTO marketing_vendors (name, contact_email, notes)
       VALUES ($1, $2, $3)
       RETURNING id, name, contact_email, status, notes, created_at`,
      [dto.name.trim(), dto.contactEmail ?? null, dto.notes ?? null],
    );
    this.logger.log(`Vendor created id=${row.id} name="${row.name}" by admin=${adminId}`);
    return { success: true, data: { ...row, id: Number(row.id) } };
  }

  async updateVendor(id: number, dto: UpdateVendorDto) {
    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (dto.name !== undefined) { fields.push(`name = $${i++}`); vals.push(dto.name); }
    if (dto.contactEmail !== undefined) { fields.push(`contact_email = $${i++}`); vals.push(dto.contactEmail); }
    if (dto.status !== undefined) { fields.push(`status = $${i++}`); vals.push(dto.status); }
    if (dto.notes !== undefined) { fields.push(`notes = $${i++}`); vals.push(dto.notes); }
    if (!fields.length) throw new BadRequestException('No fields to update');
    fields.push(`updated_at = NOW()`);
    vals.push(id);

    const row = this.firstRow(
      await this.dataSource.query(
        `UPDATE marketing_vendors SET ${fields.join(', ')} WHERE id = $${i}
         RETURNING id, name, contact_email, status, notes, created_at`,
        vals,
      ),
    );
    if (!row) throw new NotFoundException('Vendor not found');
    return { success: true, data: { ...row, id: Number(row.id) } };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: API KEYS
  // ═════════════════════════════════════════════════════════════

  async listApiKeys(vendorId: number) {
    const rows = await this.dataSource.query(
      `SELECT id, key_prefix, label, status, expires_at, last_used_at, created_at, revoked_at
         FROM marketing_vendor_api_keys
        WHERE vendor_id = $1
        ORDER BY created_at DESC`,
      [vendorId],
    );
    // The secret is intentionally absent — it exists in plaintext exactly once,
    // in the createApiKey response.
    return { success: true, data: rows.map((r: any) => ({ ...r, id: Number(r.id) })) };
  }

  /**
   * Issue a key. The plaintext `<prefix>.<secret>` is returned ONCE and never
   * stored — only sha256(secret) is persisted. Rotation = issue a new key, then
   * revoke the old one after the vendor has switched over.
   */
  async createApiKey(vendorId: number, dto: CreateApiKeyDto, adminId: number) {
    const [vendor] = await this.dataSource.query(
      `SELECT id, name FROM marketing_vendors WHERE id = $1`, [vendorId],
    );
    if (!vendor) throw new NotFoundException('Vendor not found');

    const prefix = 'mk_' + crypto.randomBytes(6).toString('base64url');
    const secret = crypto.randomBytes(32).toString('base64url');
    const keyHash = crypto.createHash('sha256').update(secret).digest('hex');

    const [row] = await this.dataSource.query(
      `INSERT INTO marketing_vendor_api_keys
         (vendor_id, key_prefix, key_hash, label, expires_at, created_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, key_prefix, label, status, expires_at, created_at`,
      [vendorId, prefix, keyHash, dto.label ?? null, dto.expiresAt ?? null, adminId],
    );

    this.logger.log(`API key issued id=${row.id} vendor=${vendorId} by admin=${adminId}`);
    return {
      success: true,
      data: {
        ...row,
        id: Number(row.id),
        // Echo the owner back explicitly. The binding comes from the URL path
        // (POST /vendors/:id/keys), so the request body alone gives no hint of
        // who the key is for — and handing the right key to the wrong agency is
        // not something you can discover later, because the secret is never
        // shown again.
        vendor_id: Number(vendorId),
        vendor_name: vendor.name,
        apiKey: `${prefix}.${secret}`,
        warning: 'Store this key now — it will never be shown again.',
      },
    };
  }

  /** Soft revoke: the row stays for the audit trail. */
  async revokeApiKey(vendorId: number, keyId: number) {
    const row = this.firstRow(
      await this.dataSource.query(
        `UPDATE marketing_vendor_api_keys
            SET status = 'REVOKED', revoked_at = NOW()
          WHERE id = $1 AND vendor_id = $2 AND status = 'ACTIVE'
          RETURNING id, key_prefix`,
        [keyId, vendorId],
      ),
    );
    if (!row) throw new NotFoundException('Active key not found for this vendor');
    return { success: true, message: `Key ${row.key_prefix} revoked` };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CHANNELS
  // ═════════════════════════════════════════════════════════════

  async listChannels(q: ChannelListQueryDto) {
    const page = Math.max(Number(q.page) || 1, 1);
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const rows = await this.dataSource.query(
      `SELECT ch.id, ch.code, ch.name, ch.platform, ch.landing_path, ch.is_active,
              ch.vendor_id, v.name AS vendor_name, ch.created_at,
              (SELECT COUNT(*)::int FROM marketing_clicks k WHERE k.channel_id = ch.id) AS clicks,
              (SELECT COUNT(*)::int FROM user_channel_attribution a WHERE a.channel_id = ch.id) AS registrations
         FROM marketing_channels ch
         LEFT JOIN marketing_vendors v ON v.id = ch.vendor_id
        WHERE ($1::bigint IS NULL OR ch.vendor_id = $1::bigint)
        ORDER BY ch.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q.vendorId ?? null, limit, offset],
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM marketing_channels ch
        WHERE ($1::bigint IS NULL OR ch.vendor_id = $1::bigint)`,
      [q.vendorId ?? null],
    );

    return {
      success: true,
      data: rows.map((r: any) => ({
        ...r,
        id: Number(r.id),
        vendor_id: r.vendor_id === null ? null : Number(r.vendor_id),
        trackingUrl: this.trackingUrl(r.code),
      })),
      page,
      limit,
      total,
    };
  }

  async createChannel(dto: CreateChannelDto, adminId: number) {
    const code = this.normalizeCode(dto.code);
    if (!code) throw new BadRequestException('code is required');

    if (dto.vendorId !== undefined) {
      const [vendor] = await this.dataSource.query(
        `SELECT id FROM marketing_vendors WHERE id = $1`, [dto.vendorId],
      );
      if (!vendor) throw new NotFoundException('Vendor not found');
    }

    try {
      const [row] = await this.dataSource.query(
        `INSERT INTO marketing_channels
           (code, name, vendor_id, platform, landing_path, created_by_admin_id,
            pixel_id, capi_access_token)
         VALUES ($1,$2,$3,$4,COALESCE($5,'/register'),$6,$7,$8)
         RETURNING id, code, name, vendor_id, platform, landing_path, is_active,
                   pixel_id, created_at`,
        [
          code,
          dto.name.trim(),
          dto.vendorId ?? null,
          dto.platform ?? null,
          dto.landingPath ?? null,
          adminId,
          dto.pixelId?.trim() || null,
          dto.capiAccessToken?.trim() || null,
        ],
      );
      this.logger.log(`Channel created code="${code}" vendor=${dto.vendorId ?? '-'} by admin=${adminId}`);
      return {
        success: true,
        data: {
          ...row,
          id: Number(row.id),
          vendor_id: row.vendor_id === null ? null : Number(row.vendor_id),
          trackingUrl: this.trackingUrl(row.code),
        },
      };
    } catch (e: any) {
      if (e.code === '23505') {
        throw new BadRequestException(`Channel code "${code}" already exists`);
      }
      throw e;
    }
  }

  async updateChannel(id: number, dto: UpdateChannelDto) {
    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (dto.name !== undefined) { fields.push(`name = $${i++}`); vals.push(dto.name); }
    if (dto.vendorId !== undefined) { fields.push(`vendor_id = $${i++}`); vals.push(dto.vendorId); }
    if (dto.platform !== undefined) { fields.push(`platform = $${i++}`); vals.push(dto.platform); }
    if (dto.landingPath !== undefined) { fields.push(`landing_path = $${i++}`); vals.push(dto.landingPath); }
    if (dto.isActive !== undefined) { fields.push(`is_active = $${i++}`); vals.push(dto.isActive); }
    // Empty string clears the binding, so a pixel can be unbound as well as set.
    if (dto.pixelId !== undefined) {
      fields.push(`pixel_id = $${i++}`); vals.push(dto.pixelId.trim() || null);
    }
    if (dto.capiAccessToken !== undefined) {
      fields.push(`capi_access_token = $${i++}`); vals.push(dto.capiAccessToken.trim() || null);
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
    fields.push(`updated_at = NOW()`);
    vals.push(id);

    const row = this.firstRow(
      await this.dataSource.query(
        `UPDATE marketing_channels SET ${fields.join(', ')} WHERE id = $${i}
         RETURNING id, code, name, vendor_id, platform, landing_path, is_active,
                   pixel_id, created_at`,
        vals,
      ),
    );
    if (!row) throw new NotFoundException('Channel not found');
    return {
      success: true,
      data: {
        ...row,
        id: Number(row.id),
        vendor_id: row.vendor_id === null ? null : Number(row.vendor_id),
        trackingUrl: this.trackingUrl(row.code),
      },
    };
  }

  /**
   * Codes seen in the wild that match no registered channel — i.e. a typo in a
   * live campaign, or traffic from a link nobody told us about. Check this
   * daily during a launch. Registering the channel afterwards does NOT
   * retro-link these rows.
   */
  async listUnknownClicks(q: UnknownClickQueryDto) {
    const page = Math.max(Number(q.page) || 1, 1);
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const { start, end } = this.bounds(q.dateFrom, q.dateTo);

    const rows = await this.dataSource.query(
      `SELECT channel_code,
              COUNT(*)::int   AS clicks,
              MIN(created_at) AS first_seen,
              MAX(created_at) AS last_seen
         FROM marketing_clicks
        WHERE is_unknown = true
          AND ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR created_at <  $2::timestamptz)
        GROUP BY channel_code
        ORDER BY clicks DESC
        LIMIT $3 OFFSET $4`,
      [start, end, limit, offset],
    );
    return { success: true, data: rows, page, limit };
  }
}

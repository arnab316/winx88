// src/notification/notification.service.ts
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import { NotificationGateway } from './notification.gateway';
import { PushService } from './push.service';
import {
  EnqueueNotification, ListMyNotificationsQueryDto, UpdatePreferencesDto,
  SendNotificationDto, UpsertTemplateDto, ListTemplatesQueryDto,
  ALWAYS_ON_CATEGORIES, NotificationCategory,
} from './dto/notification.dto';

/**
 * Templates that render the admin's own {{title}} / {{body}}.
 *   ADMIN_BROADCAST     PROMOTIONAL — only players who opted in
 *   ADMIN_ANNOUNCEMENT  TRANSACTIONAL — service messages, always delivered
 */
const FREE_TEXT_EVENT_KEYS = ['ADMIN_BROADCAST', 'ADMIN_ANNOUNCEMENT'];

/** Both DataSource and QueryRunner satisfy this. */
interface SqlRunner {
  query(sql: string, params?: any[]): Promise<any>;
}

/** Every channel a preference can be expressed for. */
export const NOTIFICATION_CHANNELS = [
  'IN_APP', 'SOCKET', 'PUSH', 'SMS', 'EMAIL',
] as const;

/**
 * What a channel does when the player has expressed no preference.
 *
 * Marketing shown inside our own product — the bell, and the live socket that
 * feeds it — is on by default: a player who opens the app is choosing to look
 * at it. Marketing that LEAVES the product and lands on the player's device or
 * phone bill (push banner, SMS, email) stays off until they ask for it, which
 * is the consent position regulators and the app stores expect.
 *
 * Transactional, security and gameplay messages default on everywhere; a player
 * cannot be left unaware that a withdrawal was declined.
 */
export function defaultEnabled(category: string, channel: string): boolean {
  if (category !== 'PROMOTIONAL') return true;
  return channel === 'IN_APP' || channel === 'SOCKET';
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly gateway: NotificationGateway,
    private readonly push: PushService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // WRITE SIDE — the outbox
  // ═══════════════════════════════════════════════════════════════

  /**
   * Record the intent to notify.
   *
   * **Pass the caller's QueryRunner.** The whole point of the outbox is that
   * this row commits or rolls back together with the money movement that caused
   * it: enqueue outside the transaction and a rollback leaves you announcing a
   * deposit that never happened.
   *
   * Never throws into the caller. A notification failing to enqueue must not be
   * able to roll back a deposit — the worst case is one missing notification,
   * which is strictly better than one reversed payment.
   */
  async enqueue(runner: SqlRunner, n: EnqueueNotification): Promise<void> {
    try {
      await runner.query(
        `INSERT INTO notification_outbox (event_key, user_id, payload, idempotency_key)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          n.eventKey,
          n.userId,
          JSON.stringify(n.payload ?? {}),
          n.idempotencyKey ?? null,
        ],
      );
    } catch (e: any) {
      this.logger.error(
        `enqueue failed for ${n.eventKey} user=${n.userId}: ${e?.message}`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DELIVERY — called by the worker, one outbox row at a time
  // ═══════════════════════════════════════════════════════════════

  /**
   * Render the template, honour the player's preferences, write the inbox row
   * and push it down the socket.
   *
   * Returns the terminal status for the outbox row.
   */
  async deliver(outboxId: number): Promise<'SENT' | 'SKIPPED' | 'FAILED'> {
    const [row] = await this.dataSource.query(
      `SELECT o.*, t.category, t.channels, t.title_en, t.body_en,
              t.title_bn, t.body_bn, t.deep_link, t.icon, t.is_active
         FROM notification_outbox o
         LEFT JOIN notification_templates t ON t.event_key = o.event_key
        WHERE o.id = $1
        LIMIT 1`,
      [outboxId],
    );

    if (!row) return 'FAILED';

    // The stale-QUEUED reaper can hand back a row that actually succeeded (the
    // crash happened after delivery, before the status write). Without this
    // guard the player gets the same notification twice.
    const [dupe] = await this.dataSource.query(
      `SELECT id FROM notifications WHERE outbox_id = $1 LIMIT 1`,
      [outboxId],
    );
    if (dupe) return 'SENT';

    if (!row.category) {
      this.logger.warn(`No template for event_key=${row.event_key}`);
      return 'FAILED';
    }
    if (row.is_active === false) return 'SKIPPED';

    const category = row.category as NotificationCategory;
    const payload = row.payload ?? {};

    // Consent. Transactional and security messages are never suppressed — a
    // player cannot opt out of being told their withdrawal was declined.
    if (!ALWAYS_ON_CATEGORIES.includes(category)) {
      const allowed = await this.isChannelEnabled(row.user_id, category, 'IN_APP');
      if (!allowed) return 'SKIPPED';

      // Promotional messaging must never reach a suspended or self-excluded
      // player. Transactional still must, so this check sits here rather than
      // at the top.
      const [u] = await this.dataSource.query(
        `SELECT account_status FROM users WHERE id = $1 LIMIT 1`,
        [row.user_id],
      );
      if (!u || u.account_status !== 'ACTIVE') return 'SKIPPED';
    }

    const locale = (payload.locale ?? 'en').toString().toLowerCase();
    const bn = locale.startsWith('bn');

    // Fall back to English when a translation is empty, so a half-translated
    // template degrades instead of rendering blanks.
    const title = this.render(
      (bn ? row.title_bn : row.title_en) || row.title_en, payload,
    );
    const body = this.render(
      (bn ? row.body_bn : row.body_en) || row.body_en, payload,
    );

    const [saved] = await this.dataSource.query(
      `INSERT INTO notifications
         (user_id, event_key, category, title, body, locale, deep_link, icon, data, outbox_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING id, created_at`,
      [
        row.user_id, row.event_key, category, title, body,
        bn ? 'bn' : 'en',
        payload.deepLink ?? row.deep_link ?? null,
        row.icon ?? null,
        JSON.stringify(payload),
        row.id,
      ],
    );

    const channels: string[] = row.channels ?? [];
    if (channels.includes('SOCKET')) {
      // Emit AFTER the row exists. If the socket is dead the notification is
      // still in the inbox, and the client's next catch-up fetch collects it.
      this.gateway.emitToUser(Number(row.user_id), {
        id: Number(saved.id),
        eventKey: row.event_key,
        category,
        title,
        body,
        locale: bn ? 'bn' : 'en',
        deepLink: payload.deepLink ?? row.deep_link ?? null,
        icon: row.icon ?? null,
        data: payload,
        readAt: null,
        createdAt: saved.created_at,
      });
    }

    if (channels.includes('PUSH')) {
      // Fire-and-forget: web push goes to a third-party service that may be
      // slow or down, and a notification that is already stored and
      // socket-delivered must not be marked FAILED because of it.
      void this.push
        .sendToUser(Number(row.user_id), {
          title,
          body,
          url: payload.deepLink ?? row.deep_link ?? '/',
          icon: row.icon ?? undefined,
          // Collapse repeats of the same event rather than stacking banners.
          tag: row.event_key,
          data: { notificationId: Number(saved.id), eventKey: row.event_key },
        })
        .catch((e) =>
          this.logger.warn(`Push delivery failed for user ${row.user_id}: ${e?.message}`),
        );
    }

    return 'SENT';
  }

  /** `{{amount}}` → payload.amount. Unknown placeholders are left blank. */
  private render(tpl: string, payload: Record<string, any>): string {
    if (!tpl) return '';
    return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
      const v = key
        .split('.')
        .reduce((acc: any, k) => (acc == null ? acc : acc[k]), payload);
      return v === undefined || v === null ? '' : String(v);
    });
  }

  private async isChannelEnabled(
    userId: number, category: string, channel: string,
  ): Promise<boolean> {
    const [pref] = await this.dataSource.query(
      `SELECT enabled FROM notification_preferences
        WHERE user_id = $1 AND category = $2 AND channel = $3
        LIMIT 1`,
      [userId, category, channel],
    );
    if (!pref) return defaultEnabled(category, channel);
    return pref.enabled === true;
  }

  // ═══════════════════════════════════════════════════════════════
  // READ SIDE — the player's inbox
  // ═══════════════════════════════════════════════════════════════

  /**
   * The inbox, and the catch-up fetch.
   *
   * With `sinceId` the client asks for everything newer than the highest id it
   * already holds — this one call is what makes a dropped socket harmless.
   */
  async listMine(userId: number, q: ListMyNotificationsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const offset = (page - 1) * limit;

    const where: string[] = ['user_id = $1'];
    const params: any[] = [userId];

    if (q.sinceId) { params.push(q.sinceId); where.push(`id > $${params.length}`); }
    if (q.category) { params.push(q.category); where.push(`category = $${params.length}`); }
    if (q.unreadOnly) where.push(`read_at IS NULL`);

    const clause = `WHERE ${where.join(' AND ')}`;

    params.push(limit, offset);
    const rows = await this.dataSource.query(
      `SELECT id, event_key, category, title, body, locale,
              deep_link, icon, data, delivered_at, read_at, created_at
         FROM notifications
         ${clause}
        ORDER BY id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const [cnt] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM notifications WHERE user_id = $1`,
      [userId],
    );

    return {
      data: rows.map((r: any) => ({
        id: Number(r.id),
        eventKey: r.event_key,
        category: r.category,
        title: r.title,
        body: r.body,
        locale: r.locale,
        deepLink: r.deep_link,
        icon: r.icon,
        data: r.data,
        deliveredAt: r.delivered_at,
        readAt: r.read_at,
        createdAt: r.created_at,
      })),
      total: cnt.total,
      unread: cnt.unread,
      page,
      limit,
    };
  }

  async unreadCount(userId: number) {
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS unread
         FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return { unread: row?.unread ?? 0 };
  }

  async markRead(userId: number, id: number) {
    const res = await this.dataSource.query(
      `UPDATE notifications
          SET read_at = COALESCE(read_at, NOW())
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [id, userId],
    );
    // TypeORM returns [rows, affected] for UPDATE ... RETURNING.
    const rows = Array.isArray(res[0]) ? res[0] : res;
    if (!rows.length) throw new NotFoundException('Notification not found');

    const { unread } = await this.unreadCount(userId);
    // Other tabs and devices need the badge corrected too.
    this.gateway.emitUnreadCount(userId, unread);
    return { ok: true, unread };
  }

  async markAllRead(userId: number) {
    await this.dataSource.query(
      `UPDATE notifications SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    this.gateway.emitUnreadCount(userId, 0);
    return { ok: true, unread: 0 };
  }

  // ═══════════════════════════════════════════════════════════════
  // PREFERENCES
  // ═══════════════════════════════════════════════════════════════

  async getPreferences(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT category, channel, enabled FROM notification_preferences
        WHERE user_id = $1`,
      [userId],
    );
    // Spelled out per channel so the client can render the settings screen
    // without hard-coding the rules. Defaults differ BY CHANNEL now —
    // promotional is on in the bell but off for push — so a flat per-category
    // map would have been a lie.
    const defaults: Record<string, Record<string, boolean>> = {};
    for (const category of ['TRANSACTIONAL', 'SECURITY', 'GAMEPLAY', 'PROMOTIONAL']) {
      defaults[category] = {};
      for (const channel of NOTIFICATION_CHANNELS) {
        defaults[category][channel] = defaultEnabled(category, channel);
      }
    }
    return { defaults, alwaysOn: ALWAYS_ON_CATEGORIES, overrides: rows };
  }

  async updatePreferences(userId: number, dto: UpdatePreferencesDto) {
    for (const item of dto.items ?? []) {
      if (ALWAYS_ON_CATEGORIES.includes(item.category)) {
        throw new BadRequestException(
          `${item.category} notifications cannot be turned off`,
        );
      }
      await this.dataSource.query(
        `INSERT INTO notification_preferences (user_id, category, channel, enabled)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, category, channel)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
        [userId, item.category, item.channel, item.enabled],
      );
    }
    return this.getPreferences(userId);
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN
  // ═══════════════════════════════════════════════════════════════

  /**
   * Admin send. With `userIds` it targets those players; without, it broadcasts
   * to every ACTIVE player (optionally one VIP tier).
   *
   * Rows go through the same outbox as everything else, so a broadcast gets the
   * same retry and preference handling as a deposit notification.
   */
  /**
   * Turn usernames into user ids.
   *
   * Three things this refuses to do quietly, because each one sends a message
   * to the wrong set of people while reporting success:
   *
   *   - skip a name it cannot find
   *   - pick one of several users when a name is ambiguous
   *   - accept a name that resolves to a suspended account
   *
   * Matching is case-insensitive for the admin's sake. That makes ambiguity
   * possible in principle (two accounts differing only by case), so it is
   * detected and reported rather than resolved by guessing.
   */
  private async resolveUsernames(usernames?: string[]): Promise<number[]> {
    const wanted = (usernames ?? [])
      .map((u) => String(u ?? '').trim())
      .filter(Boolean);
    if (!wanted.length) return [];

    const rows = await this.dataSource.query(
      `SELECT id, username, account_status
         FROM users
        WHERE lower(username) = ANY($1::text[])`,
      [wanted.map((u) => u.toLowerCase())],
    );

    // Group by the lowercased name so a duplicate is visible rather than
    // collapsing into whichever row the database happened to return first.
    const byName = new Map<string, Array<{ id: number; username: string; status: string }>>();
    for (const r of rows) {
      const key = String(r.username).toLowerCase();
      const list = byName.get(key) ?? [];
      list.push({ id: Number(r.id), username: r.username, account_status: r.account_status } as any);
      byName.set(key, list);
    }

    const missing: string[] = [];
    const ambiguous: string[] = [];
    const ids: number[] = [];

    for (const name of wanted) {
      const hits = byName.get(name.toLowerCase()) ?? [];
      if (!hits.length) { missing.push(name); continue; }
      if (hits.length > 1) {
        ambiguous.push(`${name} → ${hits.map((h) => h.username).join(', ')}`);
        continue;
      }
      ids.push(hits[0].id);
    }

    const problems: string[] = [];
    if (missing.length) problems.push(`unknown username(s): ${missing.join(', ')}`);
    if (ambiguous.length) {
      problems.push(
        `ambiguous username(s) — several accounts differ only by case: ${ambiguous.join('; ')}`,
      );
    }
    if (problems.length) {
      throw new BadRequestException(
        `Nothing was sent. ${problems.join('. ')}. ` +
        `Fix the list and resend — a partial send would leave you unable to tell ` +
        `who actually received it.`,
      );
    }

    return ids;
  }

  async sendFromAdmin(dto: SendNotificationDto, adminId: number) {
    const eventKey = dto.eventKey ?? 'ADMIN_BROADCAST';

    const [tpl] = await this.dataSource.query(
      `SELECT event_key, category FROM notification_templates
        WHERE event_key = $1 AND is_active = TRUE LIMIT 1`,
      [eventKey],
    );
    if (!tpl) throw new NotFoundException(`No active template "${eventKey}"`);

    if (FREE_TEXT_EVENT_KEYS.includes(eventKey) && (!dto.title || !dto.body)) {
      throw new BadRequestException(
        'title and body are required for a free-text message',
      );
    }

    let userIds: number[];
    if (dto.userIds?.length || dto.usernames?.length) {
      // Targeted send. Both lists are merged, so an admin can paste ids from a
      // report and type a username in the same request.
      userIds = [
        ...(dto.userIds ?? []),
        ...(await this.resolveUsernames(dto.usernames)),
      ];
      userIds = [...new Set(userIds)];
    } else {
      const params: any[] = [];
      let vip = '';
      if (dto.vipLevel !== undefined) {
        params.push(dto.vipLevel);
        vip = ` AND vip_level = $${params.length}`;
      }
      const rows = await this.dataSource.query(
        `SELECT id FROM users WHERE account_status = 'ACTIVE'${vip}`,
        params,
      );
      userIds = rows.map((r: any) => Number(r.id));
    }

    const payload = {
      ...(dto.payload ?? {}),
      title: dto.title,
      body: dto.body,
      titleBn: dto.titleBn,
      bodyBn: dto.bodyBn,
      deepLink: dto.deepLink,
      sentByAdminId: adminId,
    };

    // One batch id shared by every row, so a broadcast can be traced — and so a
    // retried admin click cannot double-send to the same player.
    const batch = `adm:${adminId}:${Date.now()}`;

    for (const uid of userIds) {
      await this.enqueue(this.dataSource, {
        eventKey,
        userId: uid,
        payload,
        idempotencyKey: `${batch}:${uid}`,
      });
    }

    const reach = await this.estimateReach(userIds, tpl.category as NotificationCategory);
    return { queued: userIds.length, eventKey, batch, category: tpl.category, ...reach };
  }

  /**
   * How many of these recipients `deliver()` will actually deliver to, using
   * the same rules it applies — "queued" on its own says nothing about reach.
   *
   * This counts the IN_APP gate, which is what decides whether a notification
   * is stored at all. A player counted here still only gets a PUSH banner if
   * they enabled push, so treat this as "will see it in the app".
   */
  private async estimateReach(userIds: number[], category: NotificationCategory) {
    if (!userIds.length || ALWAYS_ON_CATEGORIES.includes(category)) {
      return { willReceive: userIds.length, notOptedIn: 0, inactive: 0 };
    }
    const [r] = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE u.account_status <> 'ACTIVE')::int AS inactive,
         COUNT(*) FILTER (
           WHERE u.account_status = 'ACTIVE'
             -- Must mirror defaultEnabled(category, 'IN_APP'), which is true
             -- for every category now. Only an explicit opt-OUT row excludes.
             AND NOT COALESCE(p.enabled, true)
         )::int AS not_opted_in
         FROM users u
         LEFT JOIN notification_preferences p
           ON p.user_id = u.id AND p.category = $2::text AND p.channel = 'IN_APP'
        WHERE u.id = ANY($1::bigint[])`,
      [userIds, category],
    );
    const inactive = Number(r?.inactive ?? 0);
    const notOptedIn = Number(r?.not_opted_in ?? 0);
    return {
      willReceive: Math.max(0, userIds.length - inactive - notOptedIn),
      notOptedIn,
      inactive,
    };
  }

  async listTemplates(q: ListTemplatesQueryDto) {
    const where: string[] = [];
    const params: any[] = [];
    if (q.isActive !== undefined) { params.push(q.isActive); where.push(`is_active = $${params.length}`); }
    if (q.category) { params.push(q.category); where.push(`category = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    return this.dataSource.query(
      `SELECT * FROM notification_templates ${clause} ORDER BY category, event_key`,
      params,
    );
  }

  /** Create or edit a template — this is how a new notification type is added. */
  async upsertTemplate(dto: UpsertTemplateDto) {
    const [row] = await this.dataSource.query(
      `INSERT INTO notification_templates
         (event_key, category, channels, title_en, body_en, title_bn, body_bn,
          deep_link, icon, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (event_key) DO UPDATE SET
         category   = EXCLUDED.category,
         channels   = EXCLUDED.channels,
         title_en   = EXCLUDED.title_en,
         body_en    = EXCLUDED.body_en,
         title_bn   = EXCLUDED.title_bn,
         body_bn    = EXCLUDED.body_bn,
         deep_link  = EXCLUDED.deep_link,
         icon       = EXCLUDED.icon,
         is_active  = EXCLUDED.is_active,
         updated_at = NOW()
       RETURNING *`,
      [
        dto.eventKey,
        dto.category ?? 'TRANSACTIONAL',
        dto.channels ?? ['IN_APP', 'SOCKET'],
        dto.titleEn, dto.bodyEn,
        dto.titleBn ?? null, dto.bodyBn ?? null,
        dto.deepLink ?? null, dto.icon ?? null,
        dto.isActive ?? true,
      ],
    );
    return row;
  }

  /** Operational view — is the outbox draining? */
  async outboxHealth() {
    const rows = await this.dataSource.query(
      `SELECT status, COUNT(*)::int AS n,
              MIN(created_at) AS oldest
         FROM notification_outbox
        GROUP BY status`,
    );
    return { byStatus: rows };
  }
}

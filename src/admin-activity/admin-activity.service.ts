import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ActivityRule, RuleCtx } from './admin-activity.rules';

/** Keys whose values are never stored, at any depth. */
const SECRET_KEY = /pass(word)?|secret|token|otp|pin\b|signature|api[-_]?key|credential/i;

/** Profile fields compared before / after a USER_EDIT. */
const PROFILE_FIELDS: Array<[string, string]> = [
  ['full_name', 'Full name'],
  ['username', 'Username'],
  ['email', 'Email'],
  ['dob', 'Date of birth'],
  ['vip_level', 'VIP level'],
  ['account_status', 'Account status'],
  ['kyc_status', 'KYC status'],
  ['kyc_rejection_reason', 'KYC reject reason'],
  ['affiliate_code', 'Affiliate'],
];

export interface RecordInput {
  adminId: number;
  method: string;
  path: string;
  ctx: RuleCtx;
  rule?: ActivityRule;
  success: boolean;
  statusCode?: number;
  error?: string;
  ip?: string;
  userAgent?: string;
  before?: Record<string, any> | null;
}

@Injectable()
export class AdminActivityService {
  private readonly logger = new Logger(AdminActivityService.name);
  private warnedMissingTable = false;

  constructor(private readonly dataSource: DataSource) {}

  // ── write ───────────────────────────────────────────────────────

  /** Never throws: a logging failure must not affect the admin's action. */
  async record(r: RecordInput): Promise<void> {
    try {
      const targets = await this.resolveTargets(r);

      let summary = r.rule ? r.rule.label(r.ctx) : `${r.method} ${r.path}`;
      const details: Record<string, any> = {
        params: r.ctx.params,
        body: this.redact(r.ctx.body),
      };

      if (r.rule?.action === 'USER_EDIT' && targets.length === 1) {
        const after = await this.profileSnapshot(targets[0]);
        const changes = this.diff(r.before, after);
        if (r.ctx.body?.password) changes.push({ field: 'Password', from: null, to: '(reset)' });
        details.changes = changes;
        if (changes.length) {
          summary += `: ${changes.map((c) => c.field === 'Password' ? 'password reset' : `${c.field} ${this.fmt(c.from)} → ${this.fmt(c.to)}`).join(', ')}`;
        }
      }
      if (!r.success) summary = `FAILED — ${summary}`;

      await this.dataSource.query(
        `INSERT INTO admin_activity_logs
           (admin_id, action, summary, method, path, target_user_ids, details,
            success, status_code, error, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6::bigint[],$7::jsonb,$8,$9,$10,$11,$12)`,
        [
          r.adminId,
          r.rule?.action ?? 'OTHER',
          summary.slice(0, 2000),
          r.method,
          r.path,
          targets,
          JSON.stringify(details),
          r.success,
          r.statusCode ?? null,
          r.error?.slice(0, 1000) ?? null,
          r.ip ?? null,
          r.userAgent?.slice(0, 300) ?? null,
        ],
      );
    } catch (e: any) {
      if (/admin_activity_logs/.test(e?.message ?? '') && /does not exist/.test(e?.message ?? '')) {
        if (!this.warnedMissingTable) {
          this.warnedMissingTable = true;
          this.logger.warn('admin_activity_logs missing — run migration 2320000000000. Admin actions are not being tracked.');
        }
        return;
      }
      this.logger.warn(`could not record admin activity for ${r.method} ${r.path}: ${e?.message}`);
    }
  }

  /** Profile + KYC + affiliate, for the USER_EDIT before/after comparison. */
  async profileSnapshot(userId: number): Promise<Record<string, any> | null> {
    try {
      const [row] = await this.dataSource.query(
        `SELECT u.full_name, u.username, u.email, u.dob::text AS dob, u.vip_level,
                u.account_status,
                uv.status AS kyc_status, uv.rejection_reason AS kyc_rejection_reason,
                (SELECT ru.user_code FROM referrals r JOIN users ru ON ru.id = r.referrer_user_id
                  WHERE r.referee_user_id = u.id LIMIT 1) AS affiliate_code
           FROM users u
           LEFT JOIN user_verifications uv ON uv.user_id = u.id
          WHERE u.id = $1`,
        [userId],
      );
      return row ?? null;
    } catch {
      return null;
    }
  }

  // ── read ────────────────────────────────────────────────────────

  async list(q: {
    userId?: number; adminId?: number; action?: string;
    from?: string; to?: string; search?: string; page?: number; limit?: number;
  }) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const where: string[] = [];
    const params: any[] = [];
    const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

    if (q.userId) add(`? = ANY(l.target_user_ids)`, q.userId);
    if (q.adminId) add(`l.admin_id = ?`, q.adminId);
    if (q.action) add(`l.action = ?`, q.action);
    if (q.from) add(`l.created_at >= ?::date`, q.from);
    if (q.to) add(`l.created_at < (?::date + INTERVAL '1 day')`, q.to);
    if (q.search?.trim()) add(`l.summary ILIKE ?`, `%${q.search.trim()}%`);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows, [cnt]] = await Promise.all([
      this.dataSource.query(
        `SELECT l.id, l.admin_id, a.name AS admin_name, a.email AS admin_email,
                l.action, l.summary, l.method, l.path, l.target_user_ids, l.details,
                l.success, l.status_code, l.error, l.ip, l.created_at
           FROM admin_activity_logs l
           LEFT JOIN admin_users a ON a.id = l.admin_id
           ${clause}
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      ),
      this.dataSource.query(`SELECT COUNT(*)::int AS total FROM admin_activity_logs l ${clause}`, params),
    ]);

    return {
      data: rows.map((r: any) => ({
        id: Number(r.id),
        admin: r.admin_id != null
          ? { id: Number(r.admin_id), name: r.admin_name ?? null, email: r.admin_email ?? null }
          : null,
        action: r.action,
        summary: r.summary,
        method: r.method,
        path: r.path,
        targetUserIds: (r.target_user_ids ?? []).map(Number),
        changes: r.details?.changes ?? [],
        details: r.details,
        success: r.success,
        statusCode: r.status_code,
        error: r.error,
        ip: r.ip,
        createdAt: r.created_at,
      })),
      total: cnt.total,
      page,
      limit,
      totalPages: Math.ceil(cnt.total / limit) || 0,
    };
  }

  // ── helpers ─────────────────────────────────────────────────────

  private async resolveTargets(r: RecordInput): Promise<number[]> {
    const ids = new Set<number>();
    const push = (v: any) => {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) ids.add(n);
    };
    const { params, body } = r.ctx;

    push(params?.userId);
    push(body?.userId);
    push(body?.user_id);
    for (const u of Array.isArray(body?.userIds) ? body.userIds : []) push(u);

    const db = this.dataSource;
    // Usernames (notifications) and username-or-phone (manual deposit).
    const names: string[] = [
      ...(Array.isArray(body?.usernames) ? body.usernames : []),
      ...(typeof body?.usernameOrPhone === 'string' ? [body.usernameOrPhone] : []),
    ].map((s) => String(s).trim()).filter(Boolean);
    if (names.length) {
      const rows = await db.query(
        `SELECT id FROM users WHERE lower(username) = ANY($1::text[])`,
        [names.map((n) => n.toLowerCase())],
      );
      rows.forEach((x: any) => push(x.id));
      const digits = names.map((n) => n.replace(/\D/g, '').replace(/^880/, '').replace(/^0/, '')).filter((d) => d.length >= 8);
      if (digits.length && typeof body?.usernameOrPhone === 'string') {
        const ph = await db.query(
          `SELECT DISTINCT user_id FROM user_phone_numbers
            WHERE regexp_replace(regexp_replace(phone_number, '[^0-9]', '', 'g'), '^(880)?0?', '') = ANY($1::text[])`,
          [digits],
        );
        ph.forEach((x: any) => push(x.user_id));
      }
    }

    if (r.rule?.targets) {
      try {
        (await r.rule.targets(r.ctx, db)).forEach(push);
      } catch { /* a missing row just means no target */ }
    }

    // Big broadcasts would make one row reference every player; the Track tab
    // of each would fill with one notice. Cap it — the body still names them.
    return [...ids].slice(0, 500);
  }

  private redact(v: any, depth = 0): any {
    if (v === null || v === undefined || depth > 6) return v;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => this.redact(x, depth + 1));
    if (typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = SECRET_KEY.test(k) ? '***' : this.redact(val, depth + 1);
      }
      return out;
    }
    if (typeof v === 'string' && v.length > 2000) return `${v.slice(0, 2000)}…`;
    return v;
  }

  private diff(before: Record<string, any> | null | undefined, after: Record<string, any> | null) {
    if (!before || !after) return [] as Array<{ field: string; from: any; to: any }>;
    const norm = (x: any) => (x === undefined || x === '' ? null : x == null ? null : String(x));
    return PROFILE_FIELDS
      .filter(([k]) => norm(before[k]) !== norm(after[k]))
      .map(([k, label]) => ({ field: label, from: before[k] ?? null, to: after[k] ?? null }));
  }

  private fmt(v: any) {
    return v === null || v === undefined || v === '' ? '(empty)' : `"${v}"`;
  }
}

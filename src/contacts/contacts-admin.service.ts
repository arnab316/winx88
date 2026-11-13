import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { phoneMatchForms } from 'src/common/phone.util';

export interface ListContactsQuery {
  page?: number;
  limit?: number;
  /** Matches an uploader's username, a contact's name, or a phone number. */
  search?: string;
  /** Only this uploader's book. */
  userId?: number;
  /** 'yes' = already a player, 'no' = not a player, undefined = both. */
  matched?: 'yes' | 'no';
}

@Injectable()
export class ContactsAdminService {
  constructor(private readonly db: DataSource) {}

  /**
   * Headline counts.
   *
   * `unmatched` is split out on purpose, because it is the number that
   * carries the risk: those are phone numbers of people with no account and
   * no relationship to the platform, who never agreed to be here. Anything
   * built on this data should know how large that group is before it runs.
   */
  async stats() {
    const [row] = await this.db.query(
      `SELECT COUNT(*)::int                            AS total_contacts,
              COUNT(DISTINCT user_id)::int             AS uploaders,
              COUNT(matched_user_id)::int              AS matched,
              (COUNT(*) - COUNT(matched_user_id))::int AS unmatched,
              COUNT(DISTINCT phone_normalized)::int    AS distinct_numbers,
              MAX(last_seen_at)                        AS last_upload
         FROM device_contacts`,
    );
    return row ?? {};
  }

  /** Paginated contact rows, with the uploader and the matched player named. */
  async list(q: ListContactsQuery) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const where: string[] = [];
    const params: any[] = [];

    if (q.userId) {
      params.push(q.userId);
      where.push(`dc.user_id = $${params.length}`);
    }

    if (q.matched === 'yes') where.push('dc.matched_user_id IS NOT NULL');
    if (q.matched === 'no') where.push('dc.matched_user_id IS NULL');

    const search = q.search?.trim();
    if (search) {
      // A search that looks like a phone number is matched on digits, in
      // every prefix form, so typing `01712…` finds a contact stored as
      // `+8801712…`. Anything else is a name search.
      const forms = phoneMatchForms(search);
      if (/\d/.test(search) && forms.length) {
        params.push(forms);
        where.push(`dc.phone_normalized = ANY($${params.length}::text[])`);
      } else {
        params.push(`%${search}%`);
        const p = `$${params.length}`;
        where.push(`(dc.display_name ILIKE ${p} OR u.username ILIKE ${p})`);
      }
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [count] = await this.db.query(
      `SELECT COUNT(*)::int AS total
         FROM device_contacts dc
         LEFT JOIN users u ON u.id = dc.user_id
         ${clause}`,
      params,
    );

    params.push(limit, (page - 1) * limit);
    const rows = await this.db.query(
      `SELECT dc.id,
              dc.display_name,
              dc.phone_raw,
              dc.phone_normalized,
              dc.first_seen_at,
              dc.last_seen_at,
              dc.user_id,
              u.username        AS uploader_username,
              dc.matched_user_id,
              m.username        AS matched_username
         FROM device_contacts dc
         LEFT JOIN users u ON u.id = dc.user_id
         LEFT JOIN users m ON m.id = dc.matched_user_id
         ${clause}
         ORDER BY dc.last_seen_at DESC, dc.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      data: rows,
      total: count?.total ?? 0,
      page,
      limit,
      totalPages: Math.ceil((count?.total ?? 0) / limit),
    };
  }

  /**
   * The upload log — who sent an address book, when, and from what device.
   *
   * This is the table to reach for when someone asks why the platform has
   * their number: it names the player whose phone it came from and the moment
   * it arrived. Keep it as long as the contacts themselves, or the contacts
   * become unexplainable.
   */
  async syncs(page = 1, limit = 50, userId?: number) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(200, Math.max(1, Number(limit) || 50));
    const params: any[] = [];
    let clause = '';
    if (userId) {
      params.push(userId);
      clause = `WHERE s.user_id = $${params.length}`;
    }

    const [count] = await this.db.query(
      `SELECT COUNT(*)::int AS total FROM device_contact_syncs s ${clause}`,
      params,
    );

    params.push(l, (p - 1) * l);
    const rows = await this.db.query(
      `SELECT s.id, s.user_id, u.username, s.platform, s.device_model,
              s.app_version, s.received_count, s.stored_count,
              s.matched_count, s.created_at
         FROM device_contact_syncs s
         LEFT JOIN users u ON u.id = s.user_id
         ${clause}
         ORDER BY s.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      data: rows,
      total: count?.total ?? 0,
      page: p,
      limit: l,
      totalPages: Math.ceil((count?.total ?? 0) / l),
    };
  }

  /** One player's uploaded book — the member dialog's Contacts tab. */
  async forUser(
    userId: number,
    opts: Omit<ListContactsQuery, 'userId'> = {},
  ) {
    return this.list({ ...opts, userId, limit: opts.limit ?? 25 });
  }

  /**
   * Counts and the last upload for one player, for the tab header.
   *
   * `uploads` comes from device_contact_syncs rather than being derived from
   * the contacts: a player who uploaded and then erased has 0 contacts and a
   * non-zero upload count, and collapsing the two would hide that it ever
   * happened.
   */
  async userSummary(userId: number) {
    const [row] = await this.db.query(
      `SELECT COUNT(*)::int                            AS total,
              COUNT(matched_user_id)::int              AS matched,
              (COUNT(*) - COUNT(matched_user_id))::int AS unmatched,
              MAX(last_seen_at)                        AS last_seen
         FROM device_contacts
        WHERE user_id = $1`,
      [userId],
    );

    const [uploads] = await this.db.query(
      `SELECT COUNT(*)::int AS uploads, MAX(created_at) AS last_upload
         FROM device_contact_syncs
        WHERE user_id = $1`,
      [userId],
    );

    const [last] = await this.db.query(
      `SELECT platform, device_model, app_version, received_count,
              stored_count, matched_count, created_at
         FROM device_contact_syncs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );

    return {
      total: row?.total ?? 0,
      matched: row?.matched ?? 0,
      unmatched: row?.unmatched ?? 0,
      lastSeen: row?.last_seen ?? null,
      uploads: uploads?.uploads ?? 0,
      lastUpload: uploads?.last_upload ?? null,
      lastSync: last ?? null,
    };
  }
}

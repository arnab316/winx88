import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { normalizePhone, phoneMatchForms } from 'src/common/phone.util';
import type { SyncContactsDto } from './dto/sync-contacts.dto';

/** What one upload did, returned to the client so it can report progress. */
export interface SyncResult {
  received: number;
  stored: number;
  matched: number;
  syncId: number;
}

interface PreparedContact {
  name: string | null;
  raw: string;
  normalized: string;
}

@Injectable()
export class ContactsService {
  private readonly log = new Logger(ContactsService.name);

  constructor(private readonly db: DataSource) {}

  /**
   * Store one chunk of a player's address book.
   *
   * Idempotent per (player, number): re-uploading the same book updates
   * `last_seen_at` and the name instead of duplicating rows, so the client
   * can retry a failed chunk without consequence and a weekly re-sync does
   * not grow the table.
   */
  async sync(userId: number, body: SyncContactsDto): Promise<SyncResult> {
    const received = body.contacts?.length ?? 0;
    const prepared = this.prepare(body.contacts ?? []);

    // A player with an empty address book, or one whose every entry was
    // unparseable, still gets a sync row — "they consented and sent nothing"
    // and "they never consented" are different facts and must stay apart.
    if (prepared.length === 0) {
      const syncId = await this.recordSync(userId, body, received, 0, 0);
      return { received, stored: 0, matched: 0, syncId };
    }

    const matches = await this.resolveMatches(prepared);

    // One multi-row INSERT. 400 contacts x 5 params = 2,000 placeholders,
    // well inside Postgres' 65,535 limit, so the chunk size set by the DTO
    // governs and this never needs its own batching.
    const values: string[] = [];
    const params: any[] = [];
    prepared.forEach((c, i) => {
      const b = i * 5;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`);
      params.push(
        userId,
        c.name,
        c.raw,
        c.normalized,
        matches.get(c.normalized) ?? null,
      );
    });

    const rows = await this.db.query(
      `INSERT INTO device_contacts
         (user_id, display_name, phone_raw, phone_normalized, matched_user_id)
       VALUES ${values.join(', ')}
       ON CONFLICT (user_id, phone_normalized) DO UPDATE SET
         display_name    = COALESCE(EXCLUDED.display_name, device_contacts.display_name),
         phone_raw       = EXCLUDED.phone_raw,
         matched_user_id = EXCLUDED.matched_user_id,
         last_seen_at    = NOW()
       RETURNING matched_user_id`,
      params,
    );

    const stored = rows.length;
    const matched = rows.filter((r: any) => r.matched_user_id !== null).length;
    const syncId = await this.recordSync(userId, body, received, stored, matched);

    return { received, stored, matched, syncId };
  }

  /**
   * De-duplicate and normalise a chunk before it touches the database.
   *
   * Necessary rather than tidy: one contact with three numbers is three rows
   * from the device, and the same number written two ways is two rows. Both
   * collide on the unique index, and Postgres rejects an INSERT whose own
   * VALUES list conflicts twice ("cannot affect row a second time") — so
   * without this step a perfectly ordinary address book fails the whole
   * chunk.
   */
  private prepare(
    contacts: { name?: string; phone: string }[],
  ): PreparedContact[] {
    const byNumber = new Map<string, PreparedContact>();

    for (const c of contacts) {
      const normalized = normalizePhone(c.phone);
      // Too short to be a phone number: shortcodes, extensions, and the
      // "*123#" service dial strings that sit in most address books.
      if (normalized.length < 6) continue;

      const name = c.name?.trim() || null;
      const existing = byNumber.get(normalized);
      if (!existing) {
        byNumber.set(normalized, { name, raw: c.phone.trim(), normalized });
      } else if (!existing.name && name) {
        // Same number twice, named once — keep the name.
        existing.name = name;
      }
    }

    return [...byNumber.values()];
  }

  /**
   * Which of these numbers belong to existing players.
   *
   * Compared on digits, in every prefix form, because the stored phone is
   * never rewritten (see phone.util.ts) — `+8801712…`, `01712…` and
   * `8801712…` are one person stored three ways. The functional index from
   * migration 2400000000000 is what keeps this off a full table scan.
   */
  private async resolveMatches(
    contacts: PreparedContact[],
  ): Promise<Map<string, number>> {
    const forms = new Set<string>();
    for (const c of contacts) {
      for (const f of phoneMatchForms(c.normalized)) forms.add(f);
    }
    if (forms.size === 0) return new Map();

    const digits = String.raw`regexp_replace(phone_number, '\D', '', 'g')`;
    const rows = await this.db.query(
      `SELECT user_id, ${digits} AS digits
         FROM user_phone_numbers
        WHERE ${digits} = ANY($1::text[])`,
      [[...forms]],
    );

    // Collapse back to the canonical form the contacts are keyed on, so a
    // player stored as `01712…` matches a contact stored as `+8801712…`.
    const out = new Map<string, number>();
    for (const r of rows) {
      const canonical = normalizePhone(r.digits);
      if (canonical && !out.has(canonical)) {
        out.set(canonical, Number(r.user_id));
      }
    }
    return out;
  }

  /** The consent receipt. One row per upload, never updated. */
  private async recordSync(
    userId: number,
    body: SyncContactsDto,
    received: number,
    stored: number,
    matched: number,
  ): Promise<number> {
    const [row] = await this.db.query(
      `INSERT INTO device_contact_syncs
         (user_id, platform, device_model, app_version,
          received_count, stored_count, matched_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        userId,
        body.platform ?? null,
        body.deviceModel ?? null,
        body.appVersion ?? null,
        received,
        stored,
        matched,
      ],
    );
    return Number(row.id);
  }

  /**
   * What the platform holds on this player's address book.
   *
   * Exposed to the player, not just to admins. Someone who granted the
   * permission is entitled to see what it produced, and a feature that hides
   * that is the kind that gets an app pulled.
   */
  async mySummary(userId: number) {
    const [row] = await this.db.query(
      `SELECT COUNT(*)::int        AS total,
              COUNT(matched_user_id)::int AS matched,
              MAX(last_seen_at)    AS last_upload
         FROM device_contacts
        WHERE user_id = $1`,
      [userId],
    );
    const [sync] = await this.db.query(
      `SELECT created_at, received_count, stored_count, device_model
         FROM device_contact_syncs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );
    return {
      total: row?.total ?? 0,
      matched: row?.matched ?? 0,
      lastUpload: row?.last_upload ?? null,
      lastSync: sync ?? null,
    };
  }

  /**
   * Erase what we hold for this player.
   *
   * The counterpart to the upload, and the reason the client re-checks the
   * permission on every launch: revoking Contacts in Android settings tells
   * the app nothing and deletes nothing here, so the app calls this when it
   * notices the permission is gone. The sync rows survive deliberately —
   * they are the record that an upload happened and was later withdrawn.
   */
  async deleteMine(userId: number): Promise<{ deleted: number }> {
    // RETURNING, then count the rows. A bare DELETE gives back an empty
    // array through TypeORM's `query`, so there is no affected-row count in
    // it to read — reading one would report 0 deleted on every successful
    // call, with nothing to indicate the number was meaningless.
    const rows = await this.db.query(
      `DELETE FROM device_contacts WHERE user_id = $1 RETURNING id`,
      [userId],
    );
    // With RETURNING, TypeORM hands back [rows, count].
    const deleted = Array.isArray(rows[0]) ? rows[0].length : rows.length;
    this.log.log(`Cleared ${deleted} stored contacts for user ${userId}`);
    return { deleted };
  }
}

import { BadRequestException } from '@nestjs/common';

/**
 * ONE PHONE NUMBER = ONE ACCOUNT.
 *
 * Every write path into `user_phone_numbers` must go through this helper.
 * Two separate gaps let the same number end up on two accounts:
 *
 *   1. `UserService.addPhone` (POST /user/add-phone, and the admin add route
 *      that delegates to it) only looked for duplicates `WHERE user_id = $1`,
 *      i.e. within the SAME account. So account B could add account A's
 *      primary number as its secondary number — which is exactly what players
 *      reported doing to farm the refer-a-friend bonus.
 *   2. Even the checks that DID look across accounts (registration,
 *      adminUpdatePhone) compared raw strings. `+8801969552779`,
 *      `8801969552779`, `01969552779` and `019 6955 2779` are the same phone
 *      but four different strings, so any of them slipped past.
 *
 * Both are closed by comparing the DIGITS ONLY, in every equivalent prefix
 * form. The DB unique index added in migration 2030000000000 is the backstop
 * against two concurrent requests racing past the SELECT.
 *
 * NOTE: this only normalises the value used for COMPARISON. The stored string
 * is left exactly as the caller typed it, because login matches the stored
 * phone verbatim — rewriting stored numbers would lock people out.
 */

/** Anything with a `.query()` — DataSource or an in-transaction QueryRunner. */
type Queryable = { query(sql: string, params?: any[]): Promise<any> };

/**
 * Canonical international form for a Bangladesh mobile: `8801XXXXXXXXX`.
 * Country code 880 + the 10-digit national number (the leading `0` of the
 * local `01XXXXXXXXX` form belongs to the trunk prefix and is dropped).
 * Non-BD input falls through as bare digits rather than being mangled.
 */
export function normalizePhone(raw: string | null | undefined): string {
  let d = String(raw ?? '').replace(/\D/g, ''); // strips +, spaces, dashes, ()
  if (!d) return '';
  d = d.replace(/^00/, ''); // 008801… (IDD prefix) → 8801…
  if (d.startsWith('880')) return d;
  if (d.startsWith('0')) return `880${d.slice(1)}`; // 01969552779 → 8801969552779
  if (d.length === 10 && d.startsWith('1')) return `880${d}`; // 1969552779 → 8801969552779
  return d;
}

/**
 * Every digit-string an existing row could be stored as for this number.
 * Rows are compared digits-only, so we only need the prefix variants:
 * `8801969552779`, `01969552779`, `1969552779`.
 */
export function phoneMatchForms(raw: string | null | undefined): string[] {
  const canonical = normalizePhone(raw);
  if (!canonical) return [];

  const forms = new Set<string>([canonical]);
  if (canonical.startsWith('880')) {
    const local = canonical.slice(3);
    forms.add(local);
    forms.add(`0${local}`);
  }
  return [...forms];
}

/**
 * The account currently holding this number, or null if it is free.
 *
 * @param opts.excludePhoneId  ignore this row (editing a number in place)
 * @param opts.excludeUserId   ignore this account's own rows
 */
export async function findPhoneOwner(
  q: Queryable,
  raw: string,
  opts: { excludePhoneId?: number; excludeUserId?: number } = {},
): Promise<{ id: number; user_id: number; is_primary: boolean; username: string } | null> {
  const forms = phoneMatchForms(raw);
  if (!forms.length) return null;

  // regexp_replace is IMMUTABLE, so this is served by the expression index
  // created in migration 2030000000000 rather than a seq scan.
  const rows = await q.query(
    `SELECT p.id, p.user_id, p.is_primary, u.username
       FROM user_phone_numbers p
       JOIN users u ON u.id = p.user_id
      WHERE regexp_replace(p.phone_number, '\\D', '', 'g') = ANY($1::text[])
        AND ($2::int IS NULL OR p.id      <> $2)
        AND ($3::int IS NULL OR p.user_id <> $3)
      LIMIT 1`,
    [forms, opts.excludePhoneId ?? null, opts.excludeUserId ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Throws if the number is already on ANY account (primary or secondary).
 * Returns the canonical form for logging.
 */
export async function assertPhoneAvailable(
  q: Queryable,
  raw: string,
  opts: {
    excludePhoneId?: number;
    excludeUserId?: number;
    message?: string;
  } = {},
): Promise<string> {
  const owner = await findPhoneOwner(q, raw, opts);
  if (owner) {
    // Deliberately does not name the account holding it — that would turn this
    // endpoint into a "which number belongs to whom" oracle.
    throw new BadRequestException(
      opts.message ?? 'This phone number is already registered to an account',
    );
  }
  return normalizePhone(raw);
}

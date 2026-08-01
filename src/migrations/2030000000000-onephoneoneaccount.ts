import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ONE PHONE NUMBER = ONE ACCOUNT (database backstop).
 *
 * Players found they could take a number that was already some other account's
 * PRIMARY number and add it to their own account as a SECONDARY number
 * (POST /user/add-phone), which is a free multi-account / referral-farming
 * lever. The app-level fix lives in `src/common/phone.util.ts`; this migration
 * is the layer underneath it, so a race between two concurrent requests (or a
 * future write path that forgets the helper) still cannot create a duplicate.
 *
 * Two objects:
 *   • `normalize_phone(text)` — IMMUTABLE, so it can be indexed. Reduces a
 *     number to canonical `8801XXXXXXXXX`: digits only (drops `+`, spaces,
 *     dashes), `00` IDD prefix stripped, local `01…` promoted to `8801…`.
 *     `+8801969552779`, `8801969552779`, `01969552779` and `019-6955-2779`
 *     all collapse to the same value.
 *   • A UNIQUE index on `normalize_phone(phone_number)`.
 *
 * IMPORTANT — the unique index is created BEST-EFFORT. Production already
 * contains duplicates (that's the bug report), and `CREATE UNIQUE INDEX` fails
 * outright on existing violations. Rather than block the whole deploy — which
 * would also block the app-level fix that stops NEW duplicates — this falls
 * back to a plain (non-unique) index and prints the offending numbers. Clean
 * those accounts up, then re-run just the unique-index step:
 *
 *   CREATE UNIQUE INDEX CONCURRENTLY uq_uphone_normalized
 *     ON public.user_phone_numbers (public.normalize_phone(phone_number));
 *
 * The plain expression index is worth having on its own: it is what makes the
 * new digits-only duplicate lookup an index scan instead of a seq scan.
 *
 * Idempotent.
 */
export class OnePhoneOneAccount2030000000000 implements MigrationInterface {
  name = 'OnePhoneOneAccount2030000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── Canonicalising function (IMMUTABLE ⇒ indexable) ──
    await q.query(`
      CREATE OR REPLACE FUNCTION public.normalize_phone(raw text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      STRICT
      AS $fn$
        SELECT CASE
          WHEN d = ''                          THEN ''
          WHEN d LIKE '880%'                   THEN d
          WHEN d LIKE '0%'                     THEN '880' || substr(d, 2)
          WHEN length(d) = 10 AND d LIKE '1%'  THEN '880' || d
          ELSE d
        END
        FROM (
          SELECT regexp_replace(regexp_replace(raw, '\\D', '', 'g'), '^00', '') AS d
        ) t;
      $fn$;
    `);

    // ── Lookup index (always created) ──
    // Matches the digits-only comparison done by findPhoneOwner().
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_uphone_digits
        ON public.user_phone_numbers ((regexp_replace(phone_number, '\\D', '', 'g')));
    `);

    // ── Report any numbers already shared across accounts ──
    const dupes = await q.query(`
      SELECT public.normalize_phone(phone_number) AS number,
             COUNT(*)                             AS rows,
             COUNT(DISTINCT user_id)              AS accounts,
             array_agg(DISTINCT user_id ORDER BY user_id) AS user_ids
        FROM public.user_phone_numbers
       GROUP BY 1
      HAVING COUNT(*) > 1
       ORDER BY 2 DESC;
    `);

    if (dupes.length) {
      console.warn(
        `[${this.name}] ${dupes.length} phone number(s) are on more than one account — ` +
          `UNIQUE index SKIPPED. Resolve these, then create it manually (see migration header):`,
      );
      for (const d of dupes) {
        console.warn(
          `  ${d.number} → ${d.rows} row(s) across ${d.accounts} account(s): users [${d.user_ids}]`,
        );
      }
      return;
    }

    // ── Clean data: enforce it for good ──
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_uphone_normalized
        ON public.user_phone_numbers (public.normalize_phone(phone_number));
    `);
    console.log(`[${this.name}] UNIQUE index uq_uphone_normalized created — no duplicates found.`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.uq_uphone_normalized;`);
    await q.query(`DROP INDEX IF EXISTS public.idx_uphone_digits;`);
    await q.query(`DROP FUNCTION IF EXISTS public.normalize_phone(text);`);
  }
}

/**
 * The one definition of a business day.
 *
 * Every "today", "this month" or date-range filter the admin sees has to mean
 * the same thing, or two screens built months apart quietly disagree — which is
 * exactly what happened: the dashboard counted registrations in Asia/Dhaka
 * while the member list filtered them with bare dates evaluated in the DATABASE
 * session timezone. Same day, two different starting instants, two different
 * numbers (18 vs 16), and nothing on either screen to explain the gap.
 *
 * Dhaka rather than UTC because the business is Bangladeshi: a UTC day splits
 * the evening peak across two reporting days.
 */
export const BUSINESS_TZ = 'Asia/Dhaka';

/**
 * SQL for "this bare date, at midnight, in the business timezone".
 *
 * `$n::date` alone is a timestamp WITHOUT a zone, so Postgres resolves it using
 * the session timezone — whatever the connection happens to have. Anchoring it
 * explicitly is what makes the boundary reproducible.
 *
 * Use as the inclusive lower bound of a range.
 */
export function dayStartSql(param: string): string {
  // The `::timestamp` is load-bearing. Without it Postgres resolves
  // `date AT TIME ZONE` by casting the date to timestamptz in the SESSION zone
  // first, then converting — yielding a zoneless wall-clock reading that is
  // offset by the difference between the two zones. On a Kolkata connection
  // that put the "midnight" boundary at 00:30, silently dropping every signup
  // in the first half hour of the business day.
  return `(${param}::date::timestamp AT TIME ZONE '${BUSINESS_TZ}')`;
}

/**
 * SQL for the EXCLUSIVE upper bound of a whole-day-inclusive range: midnight at
 * the start of the following day, in the business timezone.
 *
 * So `to = '2026-10-26'` covers everything up to 2026-10-26 23:59:59.999 Dhaka,
 * and a bet at 23:59 is in the day the player thinks it is.
 */
export function dayEndExclusiveSql(param: string): string {
  // `date + interval` already yields a zoneless timestamp, so this one needs no
  // extra cast — but it is spelled out anyway so the two bounds are obviously
  // symmetrical. They were not, once, and only one end was wrong.
  return `((${param}::date + INTERVAL '1 day')::timestamp AT TIME ZONE '${BUSINESS_TZ}')`;
}

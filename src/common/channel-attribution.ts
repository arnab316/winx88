/**
 * Where a player came from, as SQL — the single definition.
 *
 * Resolved from four independent sources that were each built separately and
 * never shared a schema:
 *
 *   Affiliate       referrals                 → affiliate's username
 *   Refer A Friend  friend_referrals          → referrer's username
 *   Marketing       user_channel_attribution  → ad campaign code
 *   Direct          users.signup_domain       → which of our domains
 *
 * PRECEDENCE is by who gets paid: an affiliate earns revshare, a friend earns
 * the ৳500 bonus, an agency gets credited for ad spend, nobody is owed for a
 * direct signup. Ordering it this way keeps every screen consistent with what
 * finance actually pays out when a player somehow matches two sources.
 *
 * Direct is the fallback and never null — a player registered before
 * signup_domain existed shows type Direct with a null name, which is honest.
 * There is no backfill for a header nobody stored.
 *
 * Lives here rather than on UserService because the dashboard's registration
 * breakdown has to group players exactly the way the member list labels them.
 * A second copy would drift, and the two screens would disagree about where the
 * same player came from.
 */

/** Lateral joins resolving each attribution source. Requires alias `u`. */
export const CHANNEL_JOINS_SQL = `
    LEFT JOIN LATERAL (
      SELECT au.username
        FROM referrals r
        JOIN users au ON au.id = r.referrer_user_id
       WHERE r.referee_user_id = u.id
       LIMIT 1
    ) aff ON TRUE
    LEFT JOIN LATERAL (
      SELECT ru.username
        FROM friend_referrals fr
        JOIN users ru ON ru.id = fr.referrer_user_id
       WHERE fr.referee_user_id = u.id
       LIMIT 1
    ) frd ON TRUE
    LEFT JOIN LATERAL (
      SELECT uca.channel_code, mc.name AS channel_label
        FROM user_channel_attribution uca
        LEFT JOIN marketing_channels mc ON mc.id = uca.channel_id
       WHERE uca.user_id = u.id
       LIMIT 1
    ) mkt ON TRUE
`;

/** The two derived columns. Must be used together with CHANNEL_JOINS_SQL. */
export const CHANNEL_COLUMNS_SQL = `
    CASE
      WHEN aff.username IS NOT NULL THEN 'Affiliate'
      WHEN frd.username IS NOT NULL THEN 'Refer A Friend'
      WHEN mkt.channel_code IS NOT NULL THEN 'Marketing'
      ELSE 'Direct'
    END AS channel_type,
    CASE
      WHEN aff.username IS NOT NULL THEN aff.username
      WHEN frd.username IS NOT NULL THEN frd.username
      WHEN mkt.channel_code IS NOT NULL THEN COALESCE(mkt.channel_label, mkt.channel_code)
      ELSE u.signup_domain
    END AS channel_name
`;

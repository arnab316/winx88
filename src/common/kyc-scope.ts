/**
 * Which KYC submissions belong to the PLAYER review queue.
 *
 * Player KYC and affiliate KYC are reviewed on different pages — anything
 * belonging to the affiliate programme (an approved affiliate, or someone
 * with a pending partner application) goes to
 * GET /affiliate/admin/verifications and is never shown in the player list.
 *
 * This predicate is shared because the dashboard badge and the list it links
 * to MUST ask the same question. They did not: the list excluded affiliates
 * and the dashboard counted everything, so an affiliate's pending KYC showed
 * as "1 document to review" above a review page that was empty. A count that
 * disagrees with the page behind it is worse than no count — it sends an
 * admin looking for work that was never theirs.
 *
 * `uv` is the alias the caller must use for user_verifications.
 */
export const PLAYER_KYC_SCOPE_SQL = `
  NOT (
    EXISTS (SELECT 1 FROM affiliate_users au WHERE au.user_id = uv.user_id)
    OR EXISTS (SELECT 1 FROM affiliate_applications aa
                WHERE aa.user_id = uv.user_id AND aa.status = 'PENDING')
  )`;

/** The statuses that still need an admin decision. */
export const PLAYER_KYC_PENDING_STATUSES = `('PENDING','UNDER_REVIEW')`;

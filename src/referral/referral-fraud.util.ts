/**
 * Shared fraud heuristic for the refer-a-friend system: does $2 (referee) share
 * a device fingerprint or IP with $1 (referrer)? That pattern is the classic
 * self-referral / fake-account abuse. Sources mirror the admin Compliance check:
 * user_login_events (register/login) + user_promotion_claims.
 *
 * Returns one row: { shared_fp boolean, shared_ip boolean }.
 */
export const SHARED_DEVICE_OR_IP_SQL = `
  WITH a_fp AS (
    SELECT device_fingerprint AS v FROM user_login_events     WHERE user_id = $1 AND device_fingerprint IS NOT NULL
    UNION SELECT device_fingerprint   FROM user_promotion_claims WHERE user_id = $1 AND device_fingerprint IS NOT NULL
  ),
  a_ip AS (
    SELECT ip_address AS v FROM user_login_events     WHERE user_id = $1 AND ip_address IS NOT NULL
    UNION SELECT ip_address   FROM user_promotion_claims WHERE user_id = $1 AND ip_address IS NOT NULL
  )
  SELECT
    EXISTS (
      SELECT 1 FROM user_login_events     e WHERE e.user_id = $2 AND e.device_fingerprint IN (SELECT v FROM a_fp)
      UNION
      SELECT 1 FROM user_promotion_claims c WHERE c.user_id = $2 AND c.device_fingerprint IN (SELECT v FROM a_fp)
    ) AS shared_fp,
    EXISTS (
      SELECT 1 FROM user_login_events     e WHERE e.user_id = $2 AND e.ip_address IN (SELECT v FROM a_ip)
      UNION
      SELECT 1 FROM user_promotion_claims c WHERE c.user_id = $2 AND c.ip_address IN (SELECT v FROM a_ip)
    ) AS shared_ip
`;

export function describeShared(row: any): { shared: boolean; reason: string } {
  // TEMPORARY: IP-based matching is unreliable while every request is recorded
  // as the Docker gateway (172.17.0.1) — it flags everyone. Set
  // REFERRAL_FRAUD_IP_ENABLED=false to ignore the shared-IP signal until the
  // proxy forwards the real client IP. Device-fingerprint matching is unaffected.
  const ipEnabled = process.env.REFERRAL_FRAUD_IP_ENABLED !== 'false';

  const fp = !!row?.shared_fp;
  const ip = ipEnabled && !!row?.shared_ip;
  const parts: string[] = [];
  if (fp) parts.push('shared device fingerprint');
  if (ip) parts.push('shared IP');
  return {
    shared: fp || ip,
    reason: parts.length ? `Referrer & referee ${parts.join(' + ')}` : '',
  };
}

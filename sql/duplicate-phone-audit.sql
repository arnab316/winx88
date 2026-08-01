-- ═══════════════════════════════════════════════════════════════════════════
-- DUPLICATE PHONE NUMBER AUDIT  (READ-ONLY — no writes, safe on production)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Finds numbers that sit on more than one account, e.g. the reported pair
-- mdkhan / mdhridoy sharing 8801969552779.
--
-- Numbers are compared DIGITS-ONLY and folded to canonical 8801XXXXXXXXX, so
-- "+8801969552779", "8801969552779", "01969552779" and "019-6955-2779" are all
-- recognised as the same phone. That matters: the old duplicate checks
-- compared raw strings, so the DB genuinely contains a mix of these spellings.
--
-- Self-contained — does NOT need migration 2030000000000 to have run yet.
-- After that migration you can replace the whole `norm` CTE expression with
-- public.normalize_phone(phone_number).
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. SUMMARY: which numbers are shared, and by how many accounts ─────────
WITH norm AS (
  SELECT p.id AS phone_id, p.user_id, p.phone_number, p.is_primary, p.is_verified,
         CASE
           WHEN x.d = ''                           THEN ''
           WHEN x.d LIKE '880%'                    THEN x.d
           WHEN x.d LIKE '0%'                      THEN '880' || substr(x.d, 2)
           WHEN length(x.d) = 10 AND x.d LIKE '1%' THEN '880' || x.d
           ELSE x.d
         END AS number
    FROM public.user_phone_numbers p
    CROSS JOIN LATERAL (
      SELECT regexp_replace(regexp_replace(p.phone_number, '\D', '', 'g'), '^00', '') AS d
    ) x
)
SELECT n.number,
       COUNT(DISTINCT n.user_id)                        AS accounts,
       COUNT(*)                                         AS phone_rows,
       COUNT(*) FILTER (WHERE n.is_primary)             AS as_primary,
       COUNT(*) FILTER (WHERE NOT n.is_primary)         AS as_secondary,
       array_agg(DISTINCT u.username ORDER BY u.username) AS usernames,
       array_agg(DISTINCT n.user_id  ORDER BY n.user_id)  AS user_ids
  FROM norm n
  JOIN public.users u ON u.id = n.user_id
 WHERE n.number <> ''
 GROUP BY n.number
HAVING COUNT(DISTINCT n.user_id) > 1
 ORDER BY accounts DESC, phone_rows DESC;


-- ── 2. DETAIL: one row per account holding a shared number ────────────────
--     Shows exactly how it was stored and whether it is that account's
--     primary number or a secondary one bolted on afterwards.
WITH norm AS (
  SELECT p.id AS phone_id, p.user_id, p.phone_number, p.is_primary, p.is_verified,
         p.created_at AS phone_added_at,
         CASE
           WHEN x.d = ''                           THEN ''
           WHEN x.d LIKE '880%'                    THEN x.d
           WHEN x.d LIKE '0%'                      THEN '880' || substr(x.d, 2)
           WHEN length(x.d) = 10 AND x.d LIKE '1%' THEN '880' || x.d
           ELSE x.d
         END AS number
    FROM public.user_phone_numbers p
    CROSS JOIN LATERAL (
      SELECT regexp_replace(regexp_replace(p.phone_number, '\D', '', 'g'), '^00', '') AS d
    ) x
),
dupes AS (
  SELECT number FROM norm
   WHERE number <> ''
   GROUP BY number HAVING COUNT(DISTINCT user_id) > 1
)
SELECT n.number,
       u.id           AS user_id,
       u.user_code,
       u.username,
       u.account_status,
       n.phone_number AS stored_as,
       n.is_primary,
       n.is_verified,
       n.phone_added_at,
       u.created_at   AS account_created_at
  FROM norm n
  JOIN dupes d ON d.number = n.number
  JOIN public.users u ON u.id = n.user_id
 ORDER BY n.number, n.is_primary DESC, u.created_at;


-- ── 3. REFERRAL FARMING: shared number AND a refer-a-friend link ──────────
--     The money question — accounts that share a phone AND referred each
--     other for the ৳500 refer-a-friend bonus.
WITH norm AS (
  SELECT p.user_id,
         CASE
           WHEN x.d = ''                           THEN ''
           WHEN x.d LIKE '880%'                    THEN x.d
           WHEN x.d LIKE '0%'                      THEN '880' || substr(x.d, 2)
           WHEN length(x.d) = 10 AND x.d LIKE '1%' THEN '880' || x.d
           ELSE x.d
         END AS number
    FROM public.user_phone_numbers p
    CROSS JOIN LATERAL (
      SELECT regexp_replace(regexp_replace(p.phone_number, '\D', '', 'g'), '^00', '') AS d
    ) x
)
SELECT fr.id            AS referral_id,
       fr.status,
       fr.config_bonus_amount        AS bonus_amount,
       fr.completed_at,
       rer.username     AS referrer,
       ree.username     AS referee,
       n1.number        AS shared_number
  FROM public.friend_referrals fr
  JOIN norm n1 ON n1.user_id = fr.referrer_user_id AND n1.number <> ''
  JOIN norm n2 ON n2.user_id = fr.referee_user_id  AND n2.number = n1.number
  JOIN public.users rer ON rer.id = fr.referrer_user_id
  JOIN public.users ree ON ree.id = fr.referee_user_id
 ORDER BY fr.created_at DESC;


-- ── 4. PRE-FLIGHT for the UNIQUE index ────────────────────────────────────
--     Migration 2030000000000 skips creating uq_uphone_normalized while any
--     duplicates remain. When this returns 0, create it:
--
--       CREATE UNIQUE INDEX CONCURRENTLY uq_uphone_normalized
--         ON public.user_phone_numbers (public.normalize_phone(phone_number));
--
SELECT COUNT(*) AS duplicate_numbers_remaining
  FROM (
    SELECT CASE
             WHEN x.d LIKE '880%'                    THEN x.d
             WHEN x.d LIKE '0%'                      THEN '880' || substr(x.d, 2)
             WHEN length(x.d) = 10 AND x.d LIKE '1%' THEN '880' || x.d
             ELSE x.d
           END AS number
      FROM public.user_phone_numbers p
      CROSS JOIN LATERAL (
        SELECT regexp_replace(regexp_replace(p.phone_number, '\D', '', 'g'), '^00', '') AS d
      ) x
     GROUP BY 1 HAVING COUNT(*) > 1
  ) t;

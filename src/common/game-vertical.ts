/**
 * The one translation between what a game IS and what a promotion TARGETS.
 *
 * Two vocabularies grew up separately and have to meet when turnover is
 * counted:
 *
 *   catalog / callbacks  lowercase and granular — slots, baccarat, blackjack,
 *                        roulette, live, fishing, instant, crash
 *   promotions           the twelve verticals an admin ticks on the bonus form
 *                        — LIVE, SLOT, FISH, SPORTS, CRASH, …
 *
 * A promotion that says LIVE has to accept a blackjack table, and one that
 * says SLOT must not. Mapping that in each caller would drift the first time
 * a provider added a type, so it lives here.
 *
 * Unknown values return null, which callers MUST treat as "cannot tell" — not
 * as "ineligible". See TurnoverService.contributeFromSettledBet.
 */

/** Catalog/provider game type → the promotion vertical it belongs to. */
const TO_VERTICAL: Record<string, string> = {
  // slots
  slot: 'SLOT',
  slots: 'SLOT',
  // live dealer — every table type is "Live Casino" to a promotion
  live: 'LIVE',
  livecasino: 'LIVE',
  live_casino: 'LIVE',
  baccarat: 'LIVE',
  blackjack: 'LIVE',
  roulette: 'LIVE',
  poker: 'LIVE',
  sicbo: 'LIVE',
  dragontiger: 'LIVE',
  // the rest
  fish: 'FISH',
  fishing: 'FISH',
  fh: 'FISH',
  crash: 'CRASH',
  instant: 'CRASH',
  mini: 'CRASH',
  minigames: 'CRASH',
  mn: 'CRASH',
  sport: 'SPORTS',
  sports: 'SPORTS',
  sb: 'SPORTS',
  sportsbook: 'SPORTS',
  lottery: 'LOTTERY',
  lotto: 'LOTTERY',
  table: 'TABLE',
  arcade: 'ARCADE',
  egames: 'EGAMES',
  cockfight: 'COCKFIGHT',
  horse: 'HORSE',
};

/**
 * Normalise a game type to a promotion vertical.
 *
 * Returns null when the type is empty or unrecognised, so the caller can tell
 * "no category" apart from a category that simply does not match.
 */
export function toVertical(type?: string | null): string | null {
  const key = String(type ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '');
  if (!key) return null;
  // Already a vertical (an admin-facing value round-tripping back in).
  const upper = key.toUpperCase();
  if (Object.values(TO_VERTICAL).includes(upper)) return upper;
  return TO_VERTICAL[key] ?? null;
}

/**
 * A jsonb rule list from the database, as a clean upper-cased string array.
 *
 * Returns null for absent/empty so "no restriction" stays distinguishable
 * from "restricted to nothing" — the two mean opposite things here. Shared so
 * the snapshot written at grant time and the check run at bet time cannot
 * normalise differently.
 */
export function normaliseRuleList(raw: unknown): string[] | null {
  const arr = Array.isArray(raw) ? raw : [];
  const out = arr
    .map((v) => String(v ?? '').trim().toUpperCase())
    .filter(Boolean);
  return out.length ? out : null;
}

/**
 * The stable key the admin's exclude list stores, matching the "SOURCE:code"
 * format CatalogService.getGames() hands the promotion form.
 */
export function gameKey(source: string, code?: string | null): string | null {
  const c = String(code ?? '').trim();
  if (!c) return null;
  return `${source.trim().toUpperCase()}:${c}`;
}

/**
 * The stable key the admin's PROVIDER list stores, matching the codes
 * CatalogService.getProviders() hands the promotion form.
 *
 * A provider is only unique within its integration — OroPlay and Nexus both
 * carry a vendor called "Evolution", and Palace identifies its providers by a
 * numeric id that would collide with anything. So the integration is part of
 * the identity, exactly as it is for a game key.
 *
 * Returns null when the provider cannot be identified, which callers MUST
 * treat as "cannot tell" rather than "ineligible" — same rule as toVertical.
 */
export function providerKey(
  source: string,
  provider?: string | number | null,
): string | null {
  const p = String(provider ?? '').trim();
  if (!p) return null;
  return `${source.trim().toUpperCase()}:${p.toUpperCase()}`;
}

/**
 * OroPlay's vertical, which is carried by the VENDOR CODE prefix rather than
 * by any type field — `gameType` on its callback is a numeric id. The same
 * split the betting-history report uses.
 */
export function oroplayVertical(vendorCode?: string | null): string {
  const v = String(vendorCode ?? '').trim().toLowerCase();
  if (v.startsWith('fishing-')) return 'FISH';
  if (v.startsWith('mini-')) return 'CRASH';
  if (v.startsWith('poker-')) return 'LIVE'; // poker tables are live dealer
  return 'LIVE';
}

/** What a settled bet was placed on, as the turnover rules need to see it. */
export interface BetGameContext {
  /** Catalog/provider type — normalised here, so callers pass theirs raw. */
  type?: string | null;
  /** Which integration it came through: NEXUS, PALACE, OROPLAY, OWN, SPORTS. */
  source?: string | null;
  /** The provider's own game code, or our game id for in-house games. */
  code?: string | null;
  /**
   * The vendor WITHIN that integration — Nexus's provider_code, OroPlay's
   * vendorCode, Palace's provider_id. Optional, and when it is missing the
   * bet counts, for the same reason an unknown vertical does.
   */
  provider?: string | number | null;
}

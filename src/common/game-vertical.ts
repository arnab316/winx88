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
 * The stable key the admin's exclude list stores, matching the "SOURCE:code"
 * format CatalogService.getGames() hands the promotion form.
 */
export function gameKey(source: string, code?: string | null): string | null {
  const c = String(code ?? '').trim();
  if (!c) return null;
  return `${source.trim().toUpperCase()}:${c}`;
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
}

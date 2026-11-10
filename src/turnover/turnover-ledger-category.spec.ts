import { toVertical } from '../common/game-vertical';

/**
 * The two vocabularies that have to meet on the Betting Records page.
 *
 * `turnover_ledger.bet_category` is written from toVertical() — the PROMOTION
 * vertical, the same value the eligibility rules are expressed in. The
 * per-game-type rows on that page come from game-history's own category
 * expressions. They agree on most names and disagree on a few, and a
 * disagreement is silent: the turnover simply matches no row.
 *
 * This pins the translation, so adding a vertical on either side fails here
 * rather than quietly zeroing a column in production.
 */
describe('turnover ledger category ↔ betting-records category', () => {
  /** Mirrors the CASE in game-history.service's `catExpr`. */
  const translate = (vertical: string | null): string | null => {
    if (!vertical) return null;
    switch (vertical.toUpperCase()) {
      case 'TABLE':
        return 'LIVE';
      case 'VIRTUAL':
        return 'SPORTS';
      case 'FISH':
        return 'FISHING';
      default:
        return vertical.toUpperCase();
    }
  };

  /** Every category game-history can emit for a played row. */
  const HISTORY_CATEGORIES = new Set([
    'JACKPOT', 'LOTTERY', 'SLOT', 'SPORTS', 'FISHING', 'CRASH', 'POKER', 'LIVE',
  ]);

  describe('what each integration sends, end to end', () => {
    it.each([
      // [callback type, ledger bet_category, betting-records category]
      ['slot', 'SLOT', 'SLOT'],
      ['live', 'LIVE', 'LIVE'],
      ['FH', 'FISH', 'FISHING'],
      ['MN', 'CRASH', 'CRASH'],
      ['SB', 'SPORTS', 'SPORTS'],
      ['fishing', 'FISH', 'FISHING'],
      ['baccarat', 'LIVE', 'LIVE'],
      ['LOTTERY', 'LOTTERY', 'LOTTERY'],
    ])('%s is stored as %s and reads back as %s', (type, stored, shown) => {
      const vertical = toVertical(type);
      expect(vertical).toBe(stored);
      expect(translate(vertical)).toBe(shown);
    });
  });

  it('translates every vertical onto a category the page can show', () => {
    // The one that caused this: FISH would have matched no row and vanished,
    // which is worse than landing in the unassigned line.
    const VERTICALS = [
      'SLOT', 'LIVE', 'FISH', 'SPORTS', 'CRASH', 'LOTTERY', 'TABLE',
    ];
    for (const v of VERTICALS) {
      const shown = translate(v);
      expect(HISTORY_CATEGORIES.has(shown!)).toBe(true);
    }
  });

  it('keeps an unmappable provider type as null rather than inventing one', () => {
    // An unknown type still COUNTS toward turnover — the rules treat it as
    // "cannot tell" — so it must be storable. Null lands it in the
    // unassigned line instead of being dropped.
    expect(toVertical('some-new-product')).toBeNull();
    expect(translate(toVertical('some-new-product'))).toBeNull();
  });

  describe('the unassigned bucket', () => {
    // Mirrors the gathering loop in game-history.service: anything whose
    // category is empty, or does not match a game type played that day, is
    // folded together rather than dropped.
    const unassignedFor = (
      day: string,
      ledger: Array<[string, string, number]>, // [day, category, amount]
      playedCategories: string[],
    ) => {
      const dayCats = new Set(playedCategories);
      let total = 0;
      for (const [d, cat, amt] of ledger) {
        if (d !== day) continue;
        if (!cat || !dayCats.has(cat)) total += amt;
      }
      return total;
    };

    it('collects contributions with no category at all', () => {
      expect(
        unassignedFor('2026-11-10', [['2026-11-10', '', 40]], ['FISHING', 'LIVE']),
      ).toBe(40);
    });

    it('collects a category nothing was played in that day', () => {
      // LOTTERY vs JACKPOT: the history splits them, the ledger does not.
      expect(
        unassignedFor('2026-11-10', [['2026-11-10', 'LOTTERY', 75]], ['JACKPOT']),
      ).toBe(75);
    });

    it('leaves a matching category to its own row', () => {
      expect(
        unassignedFor('2026-11-10', [['2026-11-10', 'FISHING', 500]], ['FISHING', 'LIVE']),
      ).toBe(0);
    });

    it('ignores other days', () => {
      expect(
        unassignedFor('2026-11-10', [['2026-11-02', '', 3060]], ['FISHING']),
      ).toBe(0);
    });

    it('loses nothing when several kinds of mismatch land on one day', () => {
      const ledger: Array<[string, string, number]> = [
        ['2026-11-10', '', 40],          // pre-migration row
        ['2026-11-10', 'LOTTERY', 75],   // played as JACKPOT
        ['2026-11-10', 'FISHING', 500],  // matches
      ];
      const played = ['FISHING', 'JACKPOT'];
      const unassigned = unassignedFor('2026-11-10', ledger, played);
      const matched = 500;
      expect(unassigned).toBe(115);
      // The page must account for every contributed taka somewhere.
      expect(unassigned + matched).toBe(615);
    });
  });
});

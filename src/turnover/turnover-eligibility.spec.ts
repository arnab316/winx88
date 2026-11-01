import { TurnoverService } from './turnover.service';
import { toVertical, gameKey, providerKey } from '../common/game-vertical';

/**
 * The three game rules a promotion can put on its turnover, exercised
 * through the one function that decides whether a settled bet counts.
 *
 * `accepts` is private and takes already-derived values, so each case here
 * derives them the same way contributeFromSettledBet does — via toVertical /
 * gameKey / providerKey on a BetGameContext. That keeps the test honest about
 * the mapping as well as the matching: a provider code that normalises
 * differently on the two sides would fail here rather than in production,
 * which is the failure this feature is most exposed to.
 */
describe('TurnoverService — which bets clear a requirement', () => {
  // Only `accepts` is under test; it touches no injected dependency.
  const svc = Object.create(TurnoverService.prototype) as TurnoverService;

  const accepts = (
    req: {
      eligible_categories?: unknown;
      eligible_providers?: unknown;
      excluded_game_keys?: unknown;
    },
    bet: { type?: string | null; source?: string | null; code?: string | null; provider?: string | null },
  ) =>
    (svc as any).accepts(
      req,
      toVertical(bet.type),
      bet.source ? gameKey(bet.source, bet.code) : null,
      bet.source ? providerKey(bet.source, bet.provider) : null,
    );

  // A Pragmatic slot arriving on the Nexus callback, where `game_type` is the
  // provider's own type and `provider_code` is the vendor.
  const pragmaticSlot = {
    type: 'slot',
    source: 'NEXUS',
    code: 'vs20olympgate',
    provider: 'PRAGMATIC',
  };
  const evolutionLive = {
    type: 'live',
    source: 'NEXUS',
    code: 'evo-baccarat-a',
    provider: 'EVOLUTION',
  };

  describe('no rules at all', () => {
    it('counts every bet', () => {
      expect(accepts({}, pragmaticSlot)).toBe(true);
      expect(accepts({}, evolutionLive)).toBe(true);
    });

    it('treats an empty list as no restriction, not "nothing qualifies"', () => {
      expect(
        accepts({ eligible_categories: [], eligible_providers: [] }, pragmaticSlot),
      ).toBe(true);
    });
  });

  describe('provider selection', () => {
    const pragmaticOnly = { eligible_providers: ['NEXUS:PRAGMATIC'] };

    it('counts a bet on the selected provider', () => {
      expect(accepts(pragmaticOnly, pragmaticSlot)).toBe(true);
    });

    it('rejects a bet on any other provider', () => {
      expect(accepts(pragmaticOnly, evolutionLive)).toBe(false);
    });

    it('tells the same vendor apart across integrations', () => {
      // Nexus and OroPlay both carry a vendor named Evolution. Selecting one
      // must not let the other through.
      const nexusEvo = { eligible_providers: ['NEXUS:EVOLUTION'] };
      expect(accepts(nexusEvo, evolutionLive)).toBe(true);
      expect(
        accepts(nexusEvo, {
          type: 'live',
          source: 'OROPLAY',
          code: 'baccarat-1',
          provider: 'EVOLUTION',
        }),
      ).toBe(false);
    });

    it('matches however the provider code is cased or padded', () => {
      expect(
        accepts({ eligible_providers: ['nexus:pragmatic'] }, {
          ...pragmaticSlot,
          provider: ' Pragmatic ',
        }),
      ).toBe(true);
    });

    it('matches Palace, whose provider is a numeric id', () => {
      const palace = { type: 'slot', source: 'PALACE', code: 'jili-001', provider: 12 };
      expect(accepts({ eligible_providers: ['PALACE:12'] }, palace)).toBe(true);
      expect(accepts({ eligible_providers: ['PALACE:13'] }, palace)).toBe(false);
    });

    it('matches the Nexus sportsbook, which has no catalogue row', () => {
      const sbSlip = { type: 'SB', source: 'NEXUS', code: '', provider: 'SPORTSBOOK' };
      expect(accepts({ eligible_providers: ['NEXUS:SPORTSBOOK'] }, sbSlip)).toBe(true);
      expect(accepts({ eligible_providers: ['NEXUS:PRAGMATIC'] }, sbSlip)).toBe(false);
    });

    it('counts a bet whose provider cannot be identified', () => {
      // Deliberate: a bet we cannot attribute must not strand a player's
      // balance behind turnover they have no way to clear.
      expect(
        accepts({ eligible_providers: ['NEXUS:PRAGMATIC'] }, {
          type: 'slot',
          source: 'NEXUS',
          code: 'x',
          provider: null,
        }),
      ).toBe(true);
    });
  });

  describe('provider and category together', () => {
    // "Pragmatic's slots" — Pragmatic also runs live tables, which must not
    // count, and other studios' slots must not count either.
    const pragmaticSlotsOnly = {
      eligible_categories: ['SLOT'],
      eligible_providers: ['NEXUS:PRAGMATIC'],
    };

    it('counts the intersection', () => {
      expect(accepts(pragmaticSlotsOnly, pragmaticSlot)).toBe(true);
    });

    it('rejects the right provider in the wrong category', () => {
      expect(
        accepts(pragmaticSlotsOnly, {
          type: 'live',
          source: 'NEXUS',
          code: 'pp-baccarat',
          provider: 'PRAGMATIC',
        }),
      ).toBe(false);
    });

    it('rejects the right category from the wrong provider', () => {
      expect(
        accepts(pragmaticSlotsOnly, {
          type: 'slot',
          source: 'NEXUS',
          code: 'hacksaw-1',
          provider: 'HACKSAW',
        }),
      ).toBe(false);
    });

    it('does not let a provider rule shut off a vertical it never covered', () => {
      // Two verticals ticked, providers chosen only among slots studios. The
      // live providers were deliberately listed too, so Live Casino still
      // clears — this is the composition the form writes.
      const req = {
        eligible_categories: ['SLOT', 'LIVE'],
        eligible_providers: ['NEXUS:PRAGMATIC', 'NEXUS:EVOLUTION'],
      };
      expect(accepts(req, pragmaticSlot)).toBe(true);
      expect(accepts(req, evolutionLive)).toBe(true);
    });
  });

  describe('excluded games', () => {
    it('bars a listed game even when its provider is selected', () => {
      expect(
        accepts(
          {
            eligible_providers: ['NEXUS:PRAGMATIC'],
            excluded_game_keys: ['NEXUS:VS20OLYMPGATE'],
          },
          pragmaticSlot,
        ),
      ).toBe(false);
    });

    it('leaves that provider\'s other games alone', () => {
      expect(
        accepts(
          {
            eligible_providers: ['NEXUS:PRAGMATIC'],
            excluded_game_keys: ['NEXUS:VS20OLYMPGATE'],
          },
          { ...pragmaticSlot, code: 'vs25pandagold' },
        ),
      ).toBe(true);
    });
  });

  describe('the verticals each integration reports', () => {
    // The category half of the rule only works if both sides agree on the
    // vertical. These are the type strings the live callbacks actually send.
    it.each([
      ['slot', 'SLOT'],
      ['slots', 'SLOT'],
      ['live', 'LIVE'],
      ['baccarat', 'LIVE'],
      ['SB', 'SPORTS'],
      ['sportsbook', 'SPORTS'],
      ['MN', 'CRASH'],
      ['instant', 'CRASH'],
      ['FH', 'FISH'],
      ['fishing', 'FISH'],
    ])('maps %s to %s', (type, vertical) => {
      expect(toVertical(type)).toBe(vertical);
    });
  });
});

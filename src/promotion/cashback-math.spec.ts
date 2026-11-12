import {
  computeLossBasis,
  resolveTier,
  computeCashback,
  currentWindow,
  nextCycle,
  type CashbackTier,
} from './cashback-math';

/**
 * The rules as the spec states them, with the spec's own worked examples as
 * test cases so a change that contradicts the brief fails here.
 */
describe('cashback maths', () => {
  // "0–999 → 5%, 1000–1999 → 10%, above → 15%"
  const TIERS: CashbackTier[] = [
    { tierNo: 1, upperAmount: 999, percent: 5 },
    { tierNo: 2, upperAmount: 1999, percent: 10 },
    { tierNo: 3, upperAmount: null, percent: 15 },
  ];

  describe('loss basis', () => {
    const base = {
      countBonus: true,
      countWithdrawals: true,
      countWalletBalance: true,
    };

    it('pays nothing when a withdrawal puts the player in profit', () => {
      // Spec: deposit 300 + 300 bonus, withdrew 1000 → net +700 → nothing.
      expect(
        computeLossBasis({
          ...base,
          deposits: 300,
          bonusCredited: 300,
          withdrawals: 1000,
          closingBalance: 0,
        }),
      ).toBe(0);
    });

    it('pays nothing when the wallet still holds the money', () => {
      // Spec: deposit 300, wallet holds 1000 → net +700 → nothing.
      expect(
        computeLossBasis({
          ...base,
          deposits: 300,
          bonusCredited: 0,
          withdrawals: 0,
          closingBalance: 1000,
        }),
      ).toBe(0);
    });

    it('counts a real loss', () => {
      // 1000 deposited, 200 left: 800 lost.
      expect(
        computeLossBasis({
          ...base,
          deposits: 1000,
          bonusCredited: 0,
          withdrawals: 0,
          closingBalance: 200,
        }),
      ).toBe(800);
    });

    it('excludes bonus from the player\'s own exposure', () => {
      // 300 real + 300 bonus, all gone. Only the 300 real is rebatable.
      expect(
        computeLossBasis({
          ...base,
          deposits: 600,
          bonusCredited: 300,
          withdrawals: 0,
          closingBalance: 0,
        }),
      ).toBe(300);
    });

    it('treats bonus as the player\'s money when that check is off', () => {
      expect(
        computeLossBasis({
          ...base,
          countBonus: false,
          deposits: 600,
          bonusCredited: 300,
          withdrawals: 0,
          closingBalance: 0,
        }),
      ).toBe(600);
    });

    it('ignores a wallet balance when that check is off', () => {
      // Without the check the held 1000 no longer offsets the loss.
      expect(
        computeLossBasis({
          ...base,
          countWalletBalance: false,
          deposits: 300,
          bonusCredited: 0,
          withdrawals: 0,
          closingBalance: 1000,
        }),
      ).toBe(300);
    });

    it('breaks exactly even without paying', () => {
      expect(
        computeLossBasis({
          ...base,
          deposits: 500,
          bonusCredited: 0,
          withdrawals: 500,
          closingBalance: 0,
        }),
      ).toBe(0);
    });
  });

  describe('tier bands', () => {
    it.each([
      [1, 1, 5],
      [200, 1, 5],
      [999, 1, 5],
      [1000, 2, 10],
      [1999, 2, 10],
      [2000, 3, 15],
      [100000, 3, 15],
    ])('a basis of %s falls in tier %s at %s%%', (basis, tierNo, percent) => {
      const tier = resolveTier(basis, TIERS);
      expect(tier?.tierNo).toBe(tierNo);
      expect(tier?.percent).toBe(percent);
    });

    it('matches no tier at or below zero', () => {
      expect(resolveTier(0, TIERS)).toBeNull();
      expect(resolveTier(-50, TIERS)).toBeNull();
    });

    it('matches nothing past the top when no tier is unbounded', () => {
      // A deliberate configuration: only the first ৳2,000 is ever rebated.
      const capped = TIERS.slice(0, 2);
      expect(resolveTier(1500, capped)?.tierNo).toBe(2);
      expect(resolveTier(5000, capped)).toBeNull();
    });

    it('reads tiers in tier_no order however they arrive', () => {
      expect(resolveTier(200, [...TIERS].reverse())?.tierNo).toBe(1);
    });
  });

  describe('payout', () => {
    it('applies the band percentage to the ACTUAL basis', () => {
      // The clarified rule: ৳200 in the 0–999 band pays 5% of 200, not of 999.
      const out = computeCashback(200, { tiers: TIERS });
      expect(out.tierNo).toBe(1);
      expect(out.paidAmount).toBe(10);
    });

    it('pays the higher band rate on a bigger loss', () => {
      expect(computeCashback(1500, { tiers: TIERS }).paidAmount).toBe(150);
    });

    it('pays nothing below the minimum payout', () => {
      // Spec: minimum 10, computed 9.99 → not eligible.
      const out = computeCashback(199, { tiers: TIERS, minPayout: 10 });
      expect(out.grossAmount).toBe(9.95);
      expect(out.paidAmount).toBe(0);
      expect(out.skipReason).toBe('BELOW_MIN_PAYOUT');
      // The tier is still reported, so the near-miss is explainable.
      expect(out.tierNo).toBe(1);
    });

    it('pays once the minimum is exactly reached', () => {
      const out = computeCashback(200, { tiers: TIERS, minPayout: 10 });
      expect(out.paidAmount).toBe(10);
      expect(out.skipReason).toBeNull();
    });

    it('clamps to the maximum payout', () => {
      // Spec: lose a lakh, capped at 1000, receive 1000.
      const out = computeCashback(100000, { tiers: TIERS, maxPayout: 1000 });
      expect(out.grossAmount).toBe(15000);
      expect(out.paidAmount).toBe(1000);
      expect(out.skipReason).toBeNull();
    });

    it('treats a zero maximum as uncapped', () => {
      // Spec: no maximum set → lose a lakh, receive the full 15%.
      expect(computeCashback(100000, { tiers: TIERS, maxPayout: 0 }).paidAmount)
        .toBe(15000);
    });

    it('records why a player in profit got nothing', () => {
      const out = computeCashback(0, { tiers: TIERS });
      expect(out.paidAmount).toBe(0);
      expect(out.skipReason).toBe('NO_BASIS');
    });

    it('records when the basis matched no band', () => {
      const out = computeCashback(5000, { tiers: TIERS.slice(0, 2) });
      expect(out.skipReason).toBe('NO_TIER_MATCHED');
    });
  });

  describe('repeating cycles', () => {
    it('starts the next cycle where the last one ended', () => {
      // Spec: 3rd 22:00 → 10th 22:00, then 10th 22:00 → 17th 22:00.
      const next = nextCycle({
        cycleEnd: new Date('2026-11-10T22:00:00Z'),
        lengthMinutes: 7 * 24 * 60,
        payoutDelayMinutes: 12 * 60,
      });
      expect(next.cycleStart.toISOString()).toBe('2026-11-10T22:00:00.000Z');
      expect(next.cycleEnd.toISOString()).toBe('2026-11-17T22:00:00.000Z');
      expect(next.payoutAt.toISOString()).toBe('2026-11-18T10:00:00.000Z');
    });

    it('does not drift over many cycles', () => {
      // The reason length is stored as a duration rather than two dates.
      let cur = {
        cycleEnd: new Date('2026-01-01T00:00:00Z'),
        lengthMinutes: 7 * 24 * 60,
        payoutDelayMinutes: 0,
      };
      for (let i = 0; i < 52; i++) {
        cur = { ...cur, cycleEnd: nextCycle(cur).cycleEnd };
      }
      expect(cur.cycleEnd.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    });

    it('handles an hourly cycle, as Manual uses', () => {
      const next = nextCycle({
        cycleEnd: new Date('2026-11-10T00:00:00Z'),
        lengthMinutes: 24 * 60,
        payoutDelayMinutes: 12 * 60,
      });
      expect(next.cycleEnd.toISOString()).toBe('2026-11-11T00:00:00.000Z');
      expect(next.payoutAt.toISOString()).toBe('2026-11-11T12:00:00.000Z');
    });
  });
});

/**
 * Which window a fixed-clock promotion is in — the part that has to survive
 * the watcher not running.
 */
describe('currentWindow', () => {
  const START = new Date('2026-11-01T00:00:00Z');
  const WEEK = 7 * 24 * 60;

  const at = (iso: string, repeat = true, lengthMinutes = WEEK) =>
    currentWindow({ start: START, lengthMinutes, repeat, now: new Date(iso) });

  it('has no window before the promotion starts', () => {
    expect(at('2026-10-31T23:59:00Z')).toBeNull();
  });

  it('opens the first window on the start moment', () => {
    const w = at('2026-11-01T00:00:00Z');
    expect(w?.cycleStart.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(w?.cycleEnd.toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });

  it('stays in the first window until it closes', () => {
    expect(at('2026-11-07T23:59:00Z')?.cycleStart.toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });

  it('moves to the next window the moment the last one ends', () => {
    const w = at('2026-11-08T00:00:00Z');
    expect(w?.cycleStart.toISOString()).toBe('2026-11-08T00:00:00.000Z');
    expect(w?.cycleEnd.toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('lands on the right window after a long outage', () => {
    // The point of deriving rather than counting on: nothing ran for five
    // weeks, and the promotion resumes in the CURRENT window rather than
    // replaying the four it missed.
    const w = at('2026-12-09T12:00:00Z');
    expect(w?.cycleStart.toISOString()).toBe('2026-12-06T00:00:00.000Z');
    expect(w?.cycleEnd.toISOString()).toBe('2026-12-13T00:00:00.000Z');
  });

  it('keeps a one-off in its single window', () => {
    expect(at('2026-11-05T00:00:00Z', false)?.cycleStart.toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });

  it('closes a one-off for good once its window ends', () => {
    expect(at('2026-11-08T00:00:01Z', false)).toBeNull();
  });

  it('handles an hourly window, as a per-player cycle uses', () => {
    const w = at('2026-11-01T05:30:00Z', true, 60);
    expect(w?.cycleStart.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(w?.cycleEnd.toISOString()).toBe('2026-11-01T06:00:00.000Z');
  });

  it('rejects a zero or negative length instead of looping forever', () => {
    expect(at('2026-11-05T00:00:00Z', true, 0)).toBeNull();
    expect(at('2026-11-05T00:00:00Z', true, -60)).toBeNull();
  });
});

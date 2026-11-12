/**
 * The arithmetic behind Cashback, Rebate and Manual promotions.
 *
 * Kept apart from the engine because it is pure: given a cycle's numbers it
 * decides what is owed, with no database and no clock. That is what makes it
 * testable, and these are rules an admin will tune often.
 */

/** A band in the percentage ladder. Bands are contiguous and start at zero. */
export interface CashbackTier {
  tierNo: number;
  /** Top of the band, inclusive. Null = unbounded (last tier only). */
  upperAmount: number | null;
  percent: number;
}

export interface CashbackRules {
  tiers: CashbackTier[];
  /** Below this, nothing is paid at all. */
  minPayout?: number | null;
  /** Cap. 0 or null = uncapped. */
  maxPayout?: number | null;
}

export type SkipReason =
  | 'IN_PROFIT'
  | 'NO_BASIS'
  | 'NO_TIER_MATCHED'
  | 'BELOW_MIN_PAYOUT'
  | 'MIN_DEPOSIT_NOT_MET';

export interface CashbackOutcome {
  basisAmount: number;
  tierNo: number | null;
  tierPercent: number | null;
  /** Before the min/max clamp — kept so a clamped payout stays explainable. */
  grossAmount: number;
  paidAmount: number;
  skipReason: SkipReason | null;
}

/** Two decimals, the way money is stored. */
const money = (n: number) => Math.round(n * 100) / 100;

/**
 * What a player actually lost over a cycle.
 *
 *   real_deposits = deposits − bonus credited
 *   player_net    = withdrawals + closing balance − real_deposits
 *   loss          = −player_net, when that is negative
 *
 * Bonus is excluded because it was never the player's money: a ৳300 deposit
 * matched with ৳300 of bonus is ৳300 of real exposure, and cashback is paid
 * on exposure. Withdrawals and the closing balance both count against the
 * loss for the same reason — a player holding ৳1,000 in their wallet, or who
 * has already taken it out, has not lost it.
 *
 * Each term is switchable, because the admin decides which of them a given
 * promotion cares about.
 */
export function computeLossBasis(input: {
  deposits: number;
  bonusCredited: number;
  withdrawals: number;
  closingBalance: number;
  countBonus: boolean;
  countWithdrawals: boolean;
  countWalletBalance: boolean;
}): number {
  const realDeposits =
    input.deposits - (input.countBonus ? input.bonusCredited : 0);
  const out =
    (input.countWithdrawals ? input.withdrawals : 0) +
    (input.countWalletBalance ? input.closingBalance : 0);

  const playerNet = out - realDeposits;
  // In profit, or exactly even: nothing was lost.
  return playerNet < 0 ? money(-playerNet) : 0;
}

/**
 * The band a basis falls into.
 *
 * Bands are contiguous and start at zero: with uppers 999 / 1999 / null, a
 * basis of 200 is tier 1, 1500 is tier 2, 5000 is tier 3. An unbounded tier
 * catches everything above the last bound; without one, a basis past the top
 * bound matches nothing and pays nothing, which is a real configuration an
 * admin may want ("only the first ৳2,000 of loss is ever rebated").
 */
export function resolveTier(
  basis: number,
  tiers: CashbackTier[],
): CashbackTier | null {
  if (basis <= 0) return null;
  const ordered = [...tiers].sort((a, b) => a.tierNo - b.tierNo);
  for (const tier of ordered) {
    if (tier.upperAmount === null || basis <= tier.upperAmount) return tier;
  }
  return null;
}

/**
 * What this player is owed for one cycle.
 *
 * The percentage applies to the ACTUAL basis, not to the band's bound: a
 * ৳200 loss inside the 0–999 band pays 5% of ৳200, not 5% of ৳999.
 *
 * Returns an outcome even when nothing is paid, carrying the reason — "why
 * did I get no cashback this week" is the question this feature creates, and
 * it has to be answerable without re-deriving the maths by hand.
 */
export function computeCashback(
  basisAmount: number,
  rules: CashbackRules,
): CashbackOutcome {
  const empty = (skipReason: SkipReason): CashbackOutcome => ({
    basisAmount: money(Math.max(basisAmount, 0)),
    tierNo: null,
    tierPercent: null,
    grossAmount: 0,
    paidAmount: 0,
    skipReason,
  });

  if (!(basisAmount > 0)) return empty('NO_BASIS');

  const tier = resolveTier(basisAmount, rules.tiers);
  if (!tier) return empty('NO_TIER_MATCHED');

  const gross = money(basisAmount * (tier.percent / 100));

  const min = rules.minPayout ?? 0;
  if (min > 0 && gross < min) {
    return {
      ...empty('BELOW_MIN_PAYOUT'),
      tierNo: tier.tierNo,
      tierPercent: tier.percent,
      grossAmount: gross,
    };
  }

  // 0 or null means uncapped, which is how the form expresses "no maximum".
  const cap = rules.maxPayout ?? 0;
  const paid = cap > 0 ? Math.min(gross, cap) : gross;

  return {
    basisAmount: money(basisAmount),
    tierNo: tier.tierNo,
    tierPercent: tier.percent,
    grossAmount: gross,
    paidAmount: money(paid),
    skipReason: null,
  };
}

/**
 * Which window a fixed-clock promotion is in right now.
 *
 * Derived by stepping forward from the configured start in whole cycle
 * lengths until the window contains `now`, rather than by counting on from
 * the last window that was recorded. That matters when nothing was running:
 * a promotion created weeks ago, or one whose watcher was down over a
 * weekend, lands on the window it SHOULD be in instead of replaying every
 * window it missed.
 *
 * Returns null before the promotion starts, and for a non-repeating one
 * whose single window has already closed.
 */
export function currentWindow(input: {
  start: Date;
  lengthMinutes: number;
  repeat: boolean;
  now: Date;
}): { cycleStart: Date; cycleEnd: Date } | null {
  const lenMs = input.lengthMinutes * 60_000;
  if (!(lenMs > 0)) return null;

  const elapsed = input.now.getTime() - input.start.getTime();
  if (elapsed < 0) return null; // not started yet

  const index = input.repeat ? Math.floor(elapsed / lenMs) : 0;
  const cycleStart = new Date(input.start.getTime() + index * lenMs);
  const cycleEnd = new Date(cycleStart.getTime() + lenMs);

  // A one-off whose window has already closed has no current window.
  if (!input.repeat && cycleEnd.getTime() <= input.now.getTime()) return null;

  return { cycleStart, cycleEnd };
}

/**
 * The next cycle, when one repeats.
 *
 * The new cycle begins the instant the last one ended and runs for the same
 * length, so a repeating window never drifts — which is exactly what keeping
 * two dates the right distance apart by hand fails to do. Payout is always
 * an offset from the end, because under ON_CLAIM every player's cycle closes
 * at a different moment and no shared clock could serve them.
 */
export function nextCycle(current: {
  cycleEnd: Date;
  lengthMinutes: number;
  payoutDelayMinutes: number;
}): { cycleStart: Date; cycleEnd: Date; payoutAt: Date } {
  const MIN = 60_000;
  const cycleStart = new Date(current.cycleEnd.getTime());
  const cycleEnd = new Date(cycleStart.getTime() + current.lengthMinutes * MIN);
  const payoutAt = new Date(
    cycleEnd.getTime() + current.payoutDelayMinutes * MIN,
  );
  return { cycleStart, cycleEnd, payoutAt };
}

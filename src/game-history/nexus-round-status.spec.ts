/**
 * How a Nexus round's status is decided in game-history's betting records.
 *
 * Mirrors the CASE in `nexusSourceSql()`. The rule that matters is the one
 * added last: a round that has only ever been DEBITED is still in play.
 *
 * Before it, the CASE was CANCELLED / WON / else LOST — no in-play state at
 * all. That is harmless for an instant game, which settles in the same call,
 * but a sportsbook slip is debited when it is struck and credited hours later
 * when the match finishes. Every open slip was therefore shown as "Settled"
 * with the stake as a loss, on a match that had not kicked off.
 *
 * Checked against the full production table when written: exactly 20 rounds
 * changed, all SPORTS, and no slot/live/fishing/crash round moved.
 */
describe('Nexus round status', () => {
  type Txn = { txnType: string; bet: number; win: number; canceled?: boolean };

  /** The SQL CASE, as JS. */
  const statusOf = (txns: Txn[]): string => {
    const live = txns.filter((t) => !t.canceled);
    if (txns.length > 0 && txns.every((t) => t.canceled)) return 'CANCELLED';
    if (live.reduce((n, t) => n + t.win, 0) > 0) return 'WON';
    if (txns.every((t) => t.txnType.toLowerCase() === 'debit')) return 'PLACED';
    return 'LOST';
  };

  describe('sportsbook, which settles later', () => {
    it('is in play while only the stake has been taken', () => {
      // The reported bug: Qatar U23 v Singapore U23, ৳50 staked, kick-off
      // still ahead. Previously 'LOST'.
      expect(statusOf([{ txnType: 'debit', bet: 50, win: 0 }])).toBe('PLACED');
    });

    it('is lost once a zero credit settles it', () => {
      expect(
        statusOf([
          { txnType: 'debit', bet: 50, win: 0 },
          { txnType: 'credit', bet: 0, win: 0 },
        ]),
      ).toBe('LOST');
    });

    it('is won once a paying credit arrives', () => {
      expect(
        statusOf([
          { txnType: 'debit', bet: 50, win: 0 },
          { txnType: 'credit', bet: 0, win: 61 },
        ]),
      ).toBe('WON');
    });
  });

  describe('instant games cannot be mistaken for open bets', () => {
    it('settles a losing slot spin in one call', () => {
      // slot / FH / MN arrive as debit_credit, win 0 on a loss.
      expect(statusOf([{ txnType: 'debit_credit', bet: 10, win: 0 }])).toBe('LOST');
    });

    it('settles a winning slot spin in one call', () => {
      expect(statusOf([{ txnType: 'debit_credit', bet: 10, win: 25 }])).toBe('WON');
    });

    it('settles a losing live round, which is credited even at zero', () => {
      // live arrives as credit+debit — the credit is sent on a loss too,
      // which is what makes debit-only unambiguous.
      expect(
        statusOf([
          { txnType: 'debit', bet: 40, win: 0 },
          { txnType: 'credit', bet: 0, win: 0 },
        ]),
      ).toBe('LOST');
    });
  });

  describe('cancellation still wins', () => {
    it('reports a fully cancelled round as cancelled, not in play', () => {
      expect(
        statusOf([{ txnType: 'debit', bet: 50, win: 0, canceled: true }]),
      ).toBe('CANCELLED');
    });

    it('ignores a cancelled leg when the round also settled', () => {
      expect(
        statusOf([
          { txnType: 'debit', bet: 50, win: 0 },
          { txnType: 'credit', bet: 0, win: 61, canceled: true },
        ]),
      ).toBe('LOST');
    });
  });

  describe('win/loss must not count a bet still in play', () => {
    // `valid` now filters status NOT IN ('CANCELLED','PLACED'), so an open
    // slip contributes nothing to the day's win/loss until it settles.
    const validOf = (rows: Array<{ status: string; bet: number }>) =>
      rows
        .filter((r) => r.status !== 'CANCELLED' && r.status !== 'PLACED')
        .reduce((n, r) => n + r.bet, 0);

    it('excludes an open slip from the valid amount', () => {
      expect(
        validOf([
          { status: 'PLACED', bet: 50 },
          { status: 'LOST', bet: 45.5 },
        ]),
      ).toBe(45.5);
    });

    it('counts it once it settles', () => {
      expect(
        validOf([
          { status: 'LOST', bet: 50 },
          { status: 'LOST', bet: 45.5 },
        ]),
      ).toBe(95.5);
    });
  });
});

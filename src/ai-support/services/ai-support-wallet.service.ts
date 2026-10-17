import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { WalletService } from 'src/wallet/wallet.service';
import { TurnoverService } from 'src/turnover/turnover.service';

/**
 * Balances and transaction history.
 *
 * Read-only, and the numbers come from the wallet and turnover services the
 * player's own screens use — a support agent quoting a different balance from
 * the one in the app is worse than quoting none.
 */
@Injectable()
export class AiSupportWalletService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly wallet: WalletService,
    private readonly turnover: TurnoverService,
  ) {}

  /**
   * Balance, plus what is locked and why.
   *
   * "Locked" is the part support is actually asked about: a customer seeing a
   * balance they cannot withdraw. That lock is the turnover requirement, so
   * the summary carries it rather than leaving the agent to explain a gap.
   */
  async getSummary(userId: number) {
    const w: any = await this.wallet.getWallet(userId);
    const wallet = w?.data ?? w ?? {};

    const summary: any = await this.turnover
      .getMyTurnoverSummary(userId)
      .catch(() => null);
    const t = summary?.data ?? summary ?? null;

    const [agg] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(target_amount - current_amount)
                  FILTER (WHERE status = 'ACTIVE'), 0) AS remaining,
         COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_count
       FROM turnover_requirements WHERE user_id = $1`,
      [userId],
    );

    const balance = Number(wallet.balance ?? 0);
    const bonus = Number(wallet.bonus_balance ?? wallet.bonusBalance ?? 0);

    return {
      customerId: userId,
      currency: wallet.currency ?? 'BDT',
      balance,
      bonusBalance: bonus,
      totalBalance: Number((balance + bonus).toFixed(2)),
      wagering: {
        hasActiveRequirement: Number(agg?.active_count ?? 0) > 0,
        activeRequirements: Number(agg?.active_count ?? 0),
        remainingTurnover: Number(agg?.remaining ?? 0),
        // Whatever the turnover service itself reports, unaltered.
        summary: t,
      },
      withdrawalBlockedByWagering: Number(agg?.active_count ?? 0) > 0,
    };
  }

  /**
   * Ledger history, through the wallet service in its USER role.
   *
   * The role matters: it maps internal entry types onto the labels the
   * customer sees in their own app ("MANUAL_DEPOSIT" reads as "DEPOSIT"), so
   * the agent and the customer are describing the same line.
   */
  async getTransactions(
    userId: number,
    page = 1,
    limit = 20,
    type?: string,
  ) {
    return this.wallet.getLedgerHistory(userId, page, limit, type, 'USER');
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  GameHistoryService,
  type GameCategory,
} from 'src/game-history/game-history.service';

/**
 * Bets — placed, pending and settled.
 *
 * Every figure comes from GameHistoryService, the same unified feed the
 * player's own betting history uses. Nothing here recomputes a settlement:
 * whether a bet won, and for how much, is a stored fact produced by the
 * provider and the settlement engine. A support answer that disagreed with
 * the player's own screen would be worse than no answer.
 */
@Injectable()
export class AiSupportBetService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly history: GameHistoryService,
  ) {}

  async listBets(
    userId: number,
    q: {
      page?: number;
      limit?: number;
      status?: string;
      category?: string;
      from?: string;
      to?: string;
    },
  ) {
    const res: any = await this.history.getHistory(userId, {
      page: q.page ?? 1,
      limit: q.limit ?? 20,
      status: q.status,
      category: q.category as GameCategory | undefined,
      from: q.from,
      to: q.to,
    });
    return {
      ...res,
      data: (res?.data ?? []).map((b: any) => this.shape(b)),
    };
  }

  /**
   * Unsettled bets — `settled: false` resolves to status PLACED in the
   * history service, so the definition of "pending" stays in one place.
   */
  async listPendingBets(userId: number, page = 1, limit = 20) {
    const res: any = await this.history.getHistory(userId, {
      page,
      limit,
      settled: false,
    });
    return {
      ...res,
      data: (res?.data ?? []).map((b: any) => this.shape(b)),
    };
  }

  /**
   * One bet by its reference.
   *
   * The unified feed has no "get one" call and its `refId` is only unique
   * within a category, so the bet is located by scanning the customer's own
   * recent history. Scoped to this customer throughout — a reference from
   * someone else's account simply is not found.
   */
  async getBet(userId: number, betId: string) {
    const res: any = await this.history.getHistory(userId, {
      page: 1,
      limit: 100,
    });
    const found = (res?.data ?? []).find(
      (b: any) => String(b.refId) === betId || String(b.refCode) === betId,
    );
    if (!found) {
      throw new NotFoundException(
        'Bet not found in this customer\'s recent history',
      );
    }
    return this.shape(found);
  }

  /**
   * How a bet was settled, in words an agent can repeat.
   *
   * The reason is DERIVED FROM the stored outcome, never from re-running any
   * settlement rule.
   */
  async getSettlement(userId: number, betId: string) {
    const bet = await this.getBet(userId, betId);
    const status = String(bet.status ?? '').toUpperCase();

    const explain: Record<string, string> = {
      WON: `This bet won. ${bet.winAmount} was credited.`,
      LOST: 'This bet lost, so no payout was made.',
      PLACED: 'This bet has not been settled yet. The result is still pending.',
      CANCELLED:
        'This bet was cancelled or voided, and the stake was returned.',
    };

    return {
      betId: bet.betId,
      status,
      stake: bet.stake,
      winAmount: bet.winAmount,
      settledAt: bet.settledAt,
      isSettled: status !== 'PLACED',
      settlementReason: explain[status] ?? `This bet is ${status}.`,
      // Where the figures came from, so an agent can escalate precisely.
      source: 'settled by the game provider and recorded in game history',
    };
  }

  /** Only the fields a support agent may repeat to the customer. */
  private shape(b: any) {
    const status = String(b.status ?? '').toUpperCase();
    return {
      betId: String(b.refCode ?? b.refId),
      category: b.category,
      gameName: b.gameName ?? b.gameCode ?? null,
      provider: b.providerName ?? null,
      stake: Number(b.betAmount ?? 0),
      odds: b.payoutMultiplier != null ? Number(b.payoutMultiplier) : null,
      selection: b.betNumber ?? null,
      potentialPayout:
        b.potentialPayout != null ? Number(b.potentialPayout) : null,
      winAmount: b.actualPayout != null ? Number(b.actualPayout) : 0,
      status,
      isSettled: status !== 'PLACED',
      placedAt: b.placedAt,
      settledAt: b.settledAt ?? null,
      result: b.resultNumber ?? null,
      roundCode: b.roundCode ?? null,
    };
  }
}

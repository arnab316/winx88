// src/ledger/coin-ledger.service.ts
import { Injectable } from '@nestjs/common';
import { CoinLedgerEntry } from './dto/ledger-entry.dto';

/**
 * Single Responsibility: write to public.coin_ledger.
 * Does NOT update user_coins.total_coins — caller does that.
 */
@Injectable()
export class CoinLedgerService {
  async write(entry: CoinLedgerEntry): Promise<number> {
    const {
      qr,
      userId,
      eventType,
      coins,
      balanceBefore,
      balanceAfter,
      referenceType,
      referenceId,
      description,
    } = entry;

    const result = await qr.query(
      `INSERT INTO coin_ledger
        (user_id, event_type, coins, balance_before, balance_after,
         reference_type, reference_id, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        userId,
        eventType,
        coins,
        balanceBefore,
        balanceAfter,
        referenceType ?? null,
        referenceId ?? null,
        description ?? null,
      ],
    );

    return Number(result[0].id);
  }
}
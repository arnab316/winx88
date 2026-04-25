// src/ledger/turnover-ledger.service.ts
import { Injectable } from '@nestjs/common';
import { TurnoverLedgerEntry } from './dto/ledger-entry.dto';

/**
 * Single Responsibility: write to public.turnover_ledger.
 * The actual requirement row update is done by TurnoverService.
 */
@Injectable()
export class TurnoverLedgerService {
  async write(entry: TurnoverLedgerEntry): Promise<number> {
    const {
      qr,
      userId,
      requirementId,
      eventType,
      amount,
      balanceBefore,
      balanceAfter,
      referenceType,
      referenceId,
      description,
    } = entry;

    const result = await qr.query(
      `INSERT INTO turnover_ledger
        (user_id, requirement_id, event_type, amount,
         balance_before, balance_after,
         reference_type, reference_id, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        userId,
        requirementId,
        eventType,
        amount,
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
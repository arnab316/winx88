// src/ledger/financial-ledger.service.ts
import { Injectable } from '@nestjs/common';
import { FinancialLedgerEntry } from './dto/ledger-entry.dto';
import { randomUUID } from 'crypto';

/**
 * Single Responsibility: write rows to public.financial_ledger.
 *
 * Does NOT touch wallets. Does NOT decide if an entry is valid.
 * The caller is responsible for passing correct before/after values
 * (computed from SELECT ... FOR UPDATE in their own transaction).
 *
 * Always pass the caller's QueryRunner so the ledger write is part
 * of the same transaction. If the caller rolls back, the ledger
 * entry is rolled back too.
 */
@Injectable()
export class FinancialLedgerService {
  async write(entry: FinancialLedgerEntry): Promise<number> {
    const {
      qr,
      walletId,
      userId,
      entryType,
      flow,
      amount,
      balanceBefore,
      balanceAfter,
      bonusBefore = 0,
      bonusAfter = 0,
      lockedBefore = 0,
      lockedAfter = 0,
      referenceType,
      referenceId,
      status = 'SUCCESS',
      description,
      meta,
      createdByType = 'SYSTEM',
      createdById,
    } = entry;

    const ledgerCode = this.generateLedgerCode();

    const result = await qr.query(
      `INSERT INTO financial_ledger
        (ledger_code, user_id, wallet_id, entry_type, flow, amount,
         balance_before, balance_after,
         bonus_before, bonus_after,
         locked_before, locked_after,
         reference_type, reference_id, status, description, meta,
         created_by_type, created_by_id)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        ledgerCode,
        userId,
        walletId,
        entryType,
        flow,
        amount,
        balanceBefore,
        balanceAfter,
        bonusBefore,
        bonusAfter,
        lockedBefore,
        lockedAfter,
        referenceType,
        referenceId,
        status,
        description ?? null,
        meta ? JSON.stringify(meta) : null,
        createdByType,
        createdById ?? null,
      ],
    );

    return Number(result[0].id);
  }

  private generateLedgerCode(): string {
    // Human-trackable code + UUID tail to prevent collisions
    return `FIN-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }
}
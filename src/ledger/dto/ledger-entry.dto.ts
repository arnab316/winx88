import { QueryRunner } from 'typeorm';

// ─── Financial ledger (money) ─────────────────────────────────
export type FinancialEntryType =
  | 'DEPOSIT_PENDING'
  | 'DEPOSIT_APPROVED'
  | 'DEPOSIT_REJECTED'
  | 'BET_PLACED'
  | 'BET_CANCELLED'
  | 'WIN_CREDIT'
  | 'REFERRAL_BONUS_CREDIT'
  | 'WITHDRAWAL_REQUESTED'
  | 'WITHDRAWAL_APPROVED'
  | 'WITHDRAWAL_REJECTED'
  | 'MANUAL_ADJUSTMENT'
  | 'PROMOTION_BONUS';

export type FinancialFlow = 'CREDIT' | 'DEBIT' | 'LOCK' | 'RELEASE';
export type ActorType = 'SYSTEM' | 'ADMIN' | 'USER';

export interface FinancialLedgerEntry {
  qr: QueryRunner;
  walletId: number;
  userId: number;
  entryType: FinancialEntryType;
  flow: FinancialFlow;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  bonusBefore?: number;
  bonusAfter?: number;
  lockedBefore?: number;
  lockedAfter?: number;
  referenceType: string;       // 'DEPOSIT' | 'WITHDRAWAL' | 'BET' | 'BET_SETTLEMENT' | 'MANUAL_ADJUSTMENT' | ...
  referenceId: number;
  status?: 'PENDING' | 'SUCCESS' | 'FAILED';
  description?: string;
  meta?: Record<string, any>;
  createdByType?: ActorType;
  createdById?: number;
}

// ─── Coin ledger ──────────────────────────────────────────────
export type CoinEventType =
  | 'DEPOSIT_REWARD'
  | 'LEVEL_UP'
  | 'ADMIN_ADJUST'
  | 'REDEEMED'
  | 'EXPIRED';

export interface CoinLedgerEntry {
  qr: QueryRunner;
  userId: number;
  eventType: CoinEventType;
  coins: number;                // always >= 0; direction conveyed by eventType semantics
  balanceBefore: number;
  balanceAfter: number;
  referenceType?: string;       // 'DEPOSIT' | 'ADMIN' | 'LEVEL'
  referenceId?: number;
  description?: string;
}

// ─── Turnover ledger ──────────────────────────────────────────
export type TurnoverEventType =
  | 'CONTRIBUTION'
  | 'COMPLETED'
  | 'RESET'
  | 'CANCELLED'
  | 'ADMIN_ADJUST';

export interface TurnoverLedgerEntry {
  qr: QueryRunner;
  userId: number;
  requirementId: number;
  eventType: TurnoverEventType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceType?: string;       // 'BET' | 'WITHDRAWAL' | 'ADMIN'
  referenceId?: number;
  description?: string;
}
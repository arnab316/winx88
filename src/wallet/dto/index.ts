export type EntryType =
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
  | 'MANUAL_ADJUSTMENT';

export type Flow = 'CREDIT' | 'DEBIT' | 'LOCK' | 'RELEASE';

export type ReferenceType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'BET'
  | 'BET_SETTLEMENT'
  | 'REFERRAL_BONUS'
  | 'MANUAL_ADJUSTMENT'
  | 'PROMOTION';

type CreatedByType = 'SYSTEM' | 'ADMIN' | 'USER';

export interface LedgerParams {
  walletId: number;
  userId: number;
  entryType: EntryType;
  flow: Flow;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  bonusBefore?: number;
  bonusAfter?: number;
  lockedBefore?: number;
  lockedAfter?: number;
  referenceType: ReferenceType;
  referenceId: number;
  status?: 'SUCCESS' | 'PENDING' | 'FAILED';
  description?: string;
  meta?: Record<string, any>;
  createdByType?: CreatedByType;
  createdById?: number; 
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface DepositRequestDto {
  userId: number;
  gatewayId: number;
  amount: number;
  transactionNumber: string;
  screenshotUrl: string;    // S3 key/URL — uploaded before calling this,
  agentId?: number;        // Optional agent ID for tracking,
  promotionId?: number;    // Optional promotion ID for tracking,
}

export interface WithdrawalRequestDto {
  userId: number;
  gatewayId: number;
  amount: number;
  receiveNumber: string;
}

export interface AdminDepositDecideDto {
  depositId: number;
  adminId: number;
  action: 'APPROVE' | 'REJECT';
  rejectionReason?: string;
}

export interface AdminWithdrawalDecideDto {
  withdrawalId: number;
  adminId: number;
  action: 'APPROVE' | 'REJECT';
  rejectionReason?: string;
}

export interface AdminAdjustmentDto {
  userId: number;
  adminId: number;
  amount: number;           // positive = credit, negative = debit
  description: string;
  meta?: Record<string, any>;
}


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
  adjustmentType: 'MANUAL_ADJUSTMENT' | 'MANUAL_DEPOSIT'; // ← NEW
  meta?: Record<string, any>;
  // Turnover multiplier applied to a CREDIT adjustment (ignored for debits):
  //   amount × turnoverMultiplier = turnover the user must wager off.
  //   0 (or omitted) = no turnover requirement (instantly free to withdraw).
  // The `description` becomes the requirement's header on the wagering page.
  turnoverMultiplier?: number;
}


export interface DepositListQuery {
  status?:     'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL';
  search?:     string;    // matches username, full_name, deposit_code, transaction_number
  gatewayId?:  number;
  userId?:     number;    // filter to one user's deposits
  dateFrom?:   string;    // ISO date e.g. "2026-05-01"
  dateTo?:     string;    // ISO date e.g. "2026-05-10"
  memberGroup?: string;   // VIP tier name (vip_level_config group_name / level_name)
  memberId?:   string;    // users.user_code (partial match)
  phone?:      string;    // player phone; +880 / 880 / leading-0 forms all match
  trxId?:      string;    // transaction_number (partial match)
  dpId?:       string;    // display deposit id, e.g. "DP00123" (digits → deposits.id)
  page?:       number;
  limit?:      number;
}

// Mirrors DepositListQuery — same admin search panel on the Withdraw page.
export interface WithdrawalListQuery {
  status?:     'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL';
  search?:     string;    // matches username, full_name, withdrawal_code, receive_number
  gatewayId?:  number;
  userId?:     number;    // filter to one user's withdrawals
  dateFrom?:   string;    // ISO date e.g. "2026-05-01"
  dateTo?:     string;    // ISO date e.g. "2026-05-10"
  memberGroup?: string;   // VIP tier name (vip_level_config group_name / level_name)
  memberId?:   string;    // users.user_code (partial match)
  phone?:      string;    // receive_number OR any saved player number; +880/880/0 forms match
  trxId?:      string;    // withdrawal_code (partial match) — the "TRX ID" column
  wdId?:       string;    // display withdrawal id, e.g. "WD00212" (digits → withdrawals.id)
  page?:       number;
  limit?:      number;
}

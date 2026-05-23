// ─── Seamless Wallet API DTOs (OroPlay → Operator) ───────────────

export interface BalanceRequestDto {
  userCode: string;
}

export interface TransactionRequestDto {
  userCode: string;
  vendorCode: string;
  gameCode: string;
  historyId: string;
  roundId: string;
  gameType: number; // 1: Casino, 2: Slot, 3: Other, 4: Fishing
  transactionCode: string;
  isFinished: boolean;
  isCanceled: boolean;
  amount: number;     // negative=bet, positive=win
  detail: string;
  createdAt: string;  // "yyyy-MM-dd HH:mm:ss"
}

export interface BatchTransactionsRequestDto {
  userCode: string;
  transactions: TransactionRequestDto[];
}

// ─── Response shape OroPlay expects from operator callbacks ──────
export interface OroplayCallbackResponse {
  success: boolean;
  message: number | string;
  errorCode: number;
}

// ─── Error codes per OroPlay spec ────────────────────────────────
export const OROPLAY_ERROR = {
  NO_ERROR: 0,
  USER_ALREADY_EXISTS: 1,
  USER_DOES_NOT_EXIST: 2,
  INSUFFICIENT_AGENT_BALANCE: 3,
  INSUFFICIENT_USER_BALANCE: 4,
  NO_BETTING_LOG_EXIST: 5,
  DUPLICATE_TRANSACTION: 6,
  INVALID_TRANSACTION: 7,
  BALANCE_LOG_DOES_NOT_EXIST: 8,
  VENDOR_IS_UNDER_MAINTENANCE: 9,
  GAME_IS_UNDER_MAINTENANCE: 10,
  DEPRECATED_ENDPOINT: 20,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  UNKNOWN_SERVER_ERROR: 500,
} as const;

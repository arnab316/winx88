// ─── OroPlay outbound response shape ─────────────────────────────
export interface OroplayResponse<T = any> {
  success: boolean;
  message: T;
  errorCode: number;
}

// ─── Token ───────────────────────────────────────────────────────
export interface CreateTokenResponse {
  token: string;
  expiration: number; // unix seconds
}

// ─── Vendor / Game ───────────────────────────────────────────────
export interface Vendor {
  vendorCode: string;
  type: number; // 1: live casino, 2: slot, 3: mini-game
  name: string;
  url?: string;
}

export interface Game {
  provider: string;
  vendorCode: string;
  gameId: string;
  gameCode: string;
  gameName: string;
  slug: string;
  thumbnail: string;
  updatedAt: string;
  isNew: boolean;
  underMaintenance: boolean;
}

// ─── Launch URL ──────────────────────────────────────────────────
export interface LaunchUrlArgs {
  vendorCode: string;
  gameCode: string;
  userCode: string;
  language?: string;
  lobbyUrl?: string;
  theme?: number;
}

// ─── Betting History ─────────────────────────────────────────────
export interface BettingHistory {
  id: number;
  userCode: string;
  roundId: string;
  gameCode: string;
  gameName?: string;
  vendorCode: string;
  betAmount: number;
  winAmount: number;
  beforeBalance: number;
  afterBalance: number;
  detail: string;
  status: number; // 0: Unfinished, 1: Finished, 2: Canceled
  createdAt: number;
  updatedAt: number;
}

export interface HistoryByDateResponse {
  nextStartDate: string;
  limit: number;
  histories: BettingHistory[];
}

// ─── Active Users / Call Feature ─────────────────────────────────
export interface ActiveUser {
  vendorCode: string;
  vendorName: string;
  userCode: string;
  gameCode: string;
  gameName: string;
  connectDateTime: number;
}

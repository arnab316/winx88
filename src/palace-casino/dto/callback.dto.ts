/**
 * Shape of incoming Palace callbacks. Fields vary by `command`,
 * so most are optional and we keep this loose.
 */
export interface CallbackData {
  account?: string;
  gplay_id?: string;
  trans_guid?: string;
  cancel_trans_guid?: string;
  round_id?: string;
  provider_id?: number;
  game_code?: string;
  game_type?: string;
  amount?: number;
  type?: number;
  time_stamp?: number;
  trans_id?: number;
}

export interface CallbackBody {
  command:
    | 'authenticate'
    | 'balance'
    | 'bet'
    | 'win'
    | 'cancel'
    | 'status';
  data: CallbackData;
  timestamp: string;
  /** Comma-separated check codes: 21,22,31,41,42 */
  check: string;
}

export interface CallbackResponse {
  result: number;
  status: string;
  data: { balance?: number; account?: string } | Record<string, never>;
}

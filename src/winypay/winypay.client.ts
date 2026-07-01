import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface WinyPayinRequest {
  order_id: string;
  user_id: string;
  amount: string;        // "100.00"
  pay_type: string;      // bkash | nagad
  jump_url: string;      // user redirect after paying
  callback_url: string;  // our final-result callback
  current_time?: string; // Y-m-d H:i:s
}

export interface WinyPayinResponse {
  status: 'success' | 'error';
  message?: string;
  order_id?: string;
  internal_txn_id?: string;
  pay_url?: string;
}

/**
 * Thin HTTP client for WinyPay Bangladesh.
 * Credentials come from env: WINYPAY_API_BASE, WINYPAY_MERCHANT_CODE,
 * WINYPAY_SECRET_KEY (also used to verify callback HMACs).
 */
@Injectable()
export class WinypayClient {
  private readonly logger = new Logger(WinypayClient.name);

  constructor(private readonly config: ConfigService) {}

  private base(): string {
    return (this.config.get<string>('WINYPAY_API_BASE') ?? '').replace(/\/+$/, '');
  }
  // 'test' → /api/v1/test/*.php (sandbox), 'live' → /api/v1/live/*.php (production).
  // Defaults to 'test' so we don't accidentally hit live before approval.
  private mode(): 'test' | 'live' {
    return (this.config.get<string>('WINYPAY_MODE') ?? 'test').toLowerCase() === 'live'
      ? 'live'
      : 'test';
  }
  private merchantCode(): string {
    return this.config.get<string>('WINYPAY_MERCHANT_CODE') ?? '';
  }
  /** Shared secret — request auth (payin) AND callback HMAC verification. */
  get secretKey(): string {
    return this.config.get<string>('WINYPAY_SECRET_KEY') ?? '';
  }

  async payin(req: WinyPayinRequest): Promise<WinyPayinResponse> {
    const url = `${this.base()}/api/v1/${this.mode()}/payin.php`;
    const payload = {
      merchant_code: this.merchantCode(),
      secret_key: this.secretKey,
      ...req,
    };
    this.logger.log(
      `[WinyPay payin] -> ${url} order_id=${req.order_id} amount=${req.amount} ` +
        `pay_type=${req.pay_type} callback_url=${req.callback_url} jump_url=${req.jump_url}`,
    );
    try {
      const { data } = await axios.post<WinyPayinResponse>(url, payload, {
        timeout: 20000,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });
      this.logger.log(
        `[WinyPay payin] <- status=${data?.status} order_id=${req.order_id} internal_txn_id=${data?.internal_txn_id ?? '-'}`,
      );
      return data;
    } catch (e: any) {
      this.logger.error(
        `[WinyPay payin] FAILED order_id=${req.order_id}: ${
          e?.response?.data ? JSON.stringify(e.response.data) : e?.message
        }`,
      );
      return {
        status: 'error',
        message: e?.response?.data?.message ?? e?.message ?? 'payin request failed',
        order_id: req.order_id,
        pay_url: '',
      };
    }
  }
}

import { Injectable, Logger, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * LAAFFIC SMS API v3 client.
 *
 * Auth scheme (confirmed by official Java sample):
 *   Sign = md5(API_KEY + API_SECRET + TIMESTAMP)   // lowercase hex
 *   Timestamp = Unix seconds (10-digit)
 *
 * Headers on every request:
 *   Content-Type: application/json;charset=UTF-8
 *   Api-Key: <key>
 *   Timestamp: <unix-seconds>
 *   Sign: <md5>
 */

/** sendSms / batch error codes from LAAFFIC docs. */
const SEND_ERROR_MAP: Record<string, string> = {
  '-1': 'Authentication failed (check API key/secret)',
  '-2': 'IP not whitelisted with LAAFFIC',
  '-3': 'SMS content contains sensitive characters',
  '-4': 'SMS content is empty',
  '-5': 'SMS content too long (>1024 chars)',
  '-6': 'SMS template not approved',
  '-7': 'Too many phone numbers in one request',
  '-8': 'Phone number is empty',
  '-9': 'Invalid phone number format',
  '-10': 'LAAFFIC account balance insufficient — please top up',
  '-13': 'User account locked',
  '-16': 'Timestamp expired (server clock drift?)',
  '-18': 'LAAFFIC port program error — try again later',
  '-19': 'SMS pricing not confirmed — contact LAAFFIC business team',
};

/** getReport / getSentRcd error codes. */
const REPORT_ERROR_MAP: Record<string, string> = {
  '-1': 'Authentication failed',
  '-2': 'IP not whitelisted',
  '-11': 'Incorrect time format',
  '-14': 'Field is empty or query ID is invalid',
  '-16': 'Timestamp expired',
  '-18': 'LAAFFIC port program error',
  '-19': 'SMS pricing not confirmed',
};

export type LaafficSendResult = {
  msgId?: string;
  number: string;
  raw: any;
};

@Injectable()
export class LaafficService {
  private readonly logger = new Logger(LaafficService.name);
  private readonly apiBase = 'https://api.laaffic.com/v3';

  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly appId: string;
  private readonly senderId?: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('LAAFFIC_API_KEY') ?? '';
    this.apiSecret = this.config.get<string>('LAAFFIC_API_SECRET') ?? '';
    this.appId = this.config.get<string>('LAAFFIC_APP_ID') ?? '';
    this.senderId = this.config.get<string>('LAAFFIC_SENDER_ID') || undefined;

    if (!this.apiKey || !this.apiSecret || !this.appId) {
      this.logger.warn(
        'LAAFFIC credentials missing. Set LAAFFIC_API_KEY, LAAFFIC_API_SECRET, LAAFFIC_APP_ID in .env',
      );
    }
  }

  /** Headers required by every LAAFFIC v3 call. */
  private buildHeaders(): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sign = crypto
      .createHash('md5')
      .update(this.apiKey + this.apiSecret + timestamp)
      .digest('hex');

    return {
      'Content-Type': 'application/json;charset=UTF-8',
      'Api-Key': this.apiKey,
      Timestamp: timestamp,
      Sign: sign,
    };
  }

  /** Send one SMS. Returns the platform msgId for delivery tracking. */
  async sendSms(
    phoneNumber: string,
    content: string,
    orderId?: string,
  ): Promise<LaafficSendResult> {
    const number = phoneNumber.replace(/^\+/, '').trim();

    if (!number) throw new BadRequestException('Phone number is empty');
    if (!content) throw new BadRequestException('SMS content is empty');
    if (content.length > 1024) throw new BadRequestException('SMS content too long');

    const body: Record<string, string> = {
      appId: this.appId,
      numbers: number,
      content,
    };
    if (this.senderId) body.senderId = this.senderId;
    if (orderId) body.orderId = orderId;

    let res: Response;
    try {
      res = await fetch(`${this.apiBase}/sendSms`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      this.logger.error(`LAAFFIC network error: ${err?.message}`);
      throw new InternalServerErrorException('SMS provider unreachable');
    }

    let json: any;
    try {
      json = await res.json();
    } catch {
      const txt = await res.text().catch(() => '');
      this.logger.error(`LAAFFIC non-JSON response (${res.status}): ${txt}`);
      throw new InternalServerErrorException('SMS provider returned invalid response');
    }

    const status = String(json?.status);

    if (status !== '0') {
      const friendly =
        SEND_ERROR_MAP[status] || json?.reason || `Unknown error (status=${status})`;
      this.logger.error(
        `LAAFFIC sendSms failed. status=${status} reason=${json?.reason} body=${JSON.stringify(json)}`,
      );
      throw new InternalServerErrorException(`SMS send failed: ${friendly}`);
    }

    const item = json?.array?.[0] ?? {};
    const msgId: string | undefined = item.msgId;
    this.logger.log(`SMS sent → ${number} msgId=${msgId}`);

    return { msgId, number: item.number ?? number, raw: json };
  }

  /**
   * Fetch delivery report for one or more msgIds.
   * Returns the parsed report plus a per-msgId status interpretation.
   * Per-message status:
   *   "0"  → delivered
   *   "-1" → sending / queued
   *   "1"  → failed
   */
  async getReport(msgIds: string[]): Promise<{
    summary: { success: number; fail: number; sending: number; nofound: number };
    items: Array<{
      msgId: string;
      number: string;
      status: 'delivered' | 'sending' | 'failed' | 'unknown';
      receiveTime?: string;
      raw: any;
    }>;
    raw: any;
  }> {
    if (!msgIds.length) {
      return { summary: { success: 0, fail: 0, sending: 0, nofound: 0 }, items: [], raw: null };
    }
    const ids = msgIds.join(',');
    const url = `${this.apiBase}/getReport?appId=${encodeURIComponent(
      this.appId,
    )}&msgIds=${encodeURIComponent(ids)}`;

    const res = await fetch(url, { method: 'GET', headers: this.buildHeaders() });
    const json = await res.json();

    const status = String(json?.status);
    if (status !== '0') {
      const friendly = REPORT_ERROR_MAP[status] || json?.reason || `status=${status}`;
      throw new InternalServerErrorException(`LAAFFIC getReport failed: ${friendly}`);
    }

    const items = (json?.array ?? []).map((row: any) => {
      const s = String(row?.status);
      let mapped: 'delivered' | 'sending' | 'failed' | 'unknown' = 'unknown';
      if (s === '0') mapped = 'delivered';
      else if (s === '-1') mapped = 'sending';
      else if (s === '1') mapped = 'failed';
      return {
        msgId: row.msgId,
        number: row.number,
        status: mapped,
        receiveTime: row.receiveTime,
        raw: row,
      };
    });

    return {
      summary: {
        success: parseInt(json?.success ?? '0', 10) || 0,
        fail: parseInt(json?.fail ?? '0', 10) || 0,
        sending: parseInt(json?.sending ?? '0', 10) || 0,
        nofound: parseInt(json?.nofound ?? '0', 10) || 0,
      },
      items,
      raw: json,
    };
  }

  /** Password-reset OTP convenience helper. Keep this body short — DLT templates have tight limits. */
  async sendPasswordResetOtp(phoneNumber: string, otp: string): Promise<string | undefined> {
    const content = `${otp} is your WinX88 password reset code. Valid for 5 minutes. Do not share this code with anyone.`;
    const { msgId } = await this.sendSms(phoneNumber, content);
    return msgId;
  }

  /** Phone-add verification OTP convenience helper. */
  async sendPhoneVerifyOtp(phoneNumber: string, otp: string): Promise<string | undefined> {
    const content = `${otp} is your WinX88 phone verification code. Valid for 5 minutes. Do not share this code with anyone.`;
    const { msgId } = await this.sendSms(phoneNumber, content);
    return msgId;
  }
}
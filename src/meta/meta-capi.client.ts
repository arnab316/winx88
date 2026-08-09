import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';

/**
 * Meta (Facebook) Conversions API client.
 *
 * Sends server-side conversion events to a pixel. Needed because deposits here
 * are approved by an admin long after the player's browser has gone — a pixel
 * cannot fire for the event that actually matters.
 *
 * Follows the WinyPay client's contract: explicit timeout, and failures are
 * RETURNED as a result object rather than thrown. The caller is a cron sweeper
 * that records the error and retries; an exception would just be caught and
 * discarded one frame higher.
 *
 * Never sends raw PII. Meta requires email/phone to be SHA-256 hashed, and
 * hashing lives here so no caller can accidentally skip it.
 */

export type CapiSendResult =
  | { ok: true; eventsReceived: number; fbTraceId?: string }
  | { ok: false; error: string; retryable: boolean };

/** Everything Meta can use to match an event to a person. All optional. */
export interface CapiUserData {
  email?: string | null;
  phone?: string | null;
  externalId?: string | number | null;
  clientIp?: string | null;
  userAgent?: string | null;
  fbc?: string | null;
  fbp?: string | null;
}

export interface CapiEvent {
  pixelId: string;
  accessToken?: string | null; // per-vendor override
  eventName: string;           // 'Purchase' | 'CompleteRegistration'
  eventId: string;             // dedup key, shared with the browser pixel
  eventTime: Date;
  value?: number | null;
  currency?: string;
  userData: CapiUserData;
  customData?: Record<string, unknown>;
}

@Injectable()
export class MetaCapiClient {
  private readonly logger = new Logger(MetaCapiClient.name);

  constructor(private readonly config: ConfigService) {}

  /** Master switch. Ships false so the outbox can fill and be inspected first. */
  get enabled(): boolean {
    return (this.config.get<string>('META_CAPI_ENABLED') ?? 'false').toLowerCase() === 'true';
  }

  private apiVersion(): string {
    return this.config.get<string>('META_CAPI_API_VERSION') ?? 'v21.0';
  }

  private platformToken(): string {
    return this.config.get<string>('META_CAPI_ACCESS_TOKEN') ?? '';
  }

  /**
   * Routes events to Meta's Test Events view instead of live optimisation.
   * Set this while validating, then remove it — leaving it on means the events
   * never reach the algorithm and the campaign never learns.
   */
  private testEventCode(): string | undefined {
    return this.config.get<string>('META_TEST_EVENT_CODE') || undefined;
  }

  /** Meta requires lowercase, trimmed, SHA-256 hex. */
  private hash(value?: string | null): string | undefined {
    const v = (value ?? '').trim().toLowerCase();
    if (!v) return undefined;
    return crypto.createHash('sha256').update(v).digest('hex');
  }

  /** Phone numbers hash digits-only, without a leading +. */
  private hashPhone(value?: string | null): string | undefined {
    const digits = (value ?? '').replace(/\D/g, '');
    if (!digits) return undefined;
    return crypto.createHash('sha256').update(digits).digest('hex');
  }

  /** The exact body sent to Meta. Exposed so it can be stored for disputes. */
  buildPayload(ev: CapiEvent): Record<string, unknown> {
    const u = ev.userData;
    const user_data: Record<string, unknown> = {};

    const em = this.hash(u.email);
    const ph = this.hashPhone(u.phone);
    if (em) user_data.em = [em];
    if (ph) user_data.ph = [ph];
    if (u.externalId != null) {
      const ext = this.hash(String(u.externalId));
      if (ext) user_data.external_id = [ext];
    }
    // IP and user agent are sent unhashed — Meta requires them raw.
    if (u.clientIp) user_data.client_ip_address = u.clientIp;
    if (u.userAgent) user_data.client_user_agent = u.userAgent;
    if (u.fbc) user_data.fbc = u.fbc;
    if (u.fbp) user_data.fbp = u.fbp;

    const data: Record<string, unknown> = {
      event_name: ev.eventName,
      // Meta wants Unix SECONDS and rejects events older than 7 days.
      event_time: Math.floor(ev.eventTime.getTime() / 1000),
      event_id: ev.eventId,
      action_source: 'website',
      user_data,
    };

    if (ev.value != null) {
      data.custom_data = {
        value: ev.value,
        currency: ev.currency ?? 'BDT',
        ...(ev.customData ?? {}),
      };
    } else if (ev.customData) {
      data.custom_data = ev.customData;
    }

    const body: Record<string, unknown> = { data: [data] };
    const testCode = this.testEventCode();
    if (testCode) body.test_event_code = testCode;
    return body;
  }

  async send(ev: CapiEvent): Promise<CapiSendResult> {
    const token = (ev.accessToken || this.platformToken()).trim();
    if (!token) {
      // Not retryable: no amount of waiting produces a token.
      return { ok: false, error: 'No Meta access token configured', retryable: false };
    }
    if (!ev.pixelId) {
      return { ok: false, error: 'No pixel id on event', retryable: false };
    }

    const url = `https://graph.facebook.com/${this.apiVersion()}/${ev.pixelId}/events`;
    const body = this.buildPayload(ev);

    try {
      const { data } = await axios.post(url, body, {
        timeout: 20000,
        params: { access_token: token },
        headers: { 'Content-Type': 'application/json' },
      });
      this.logger.log(
        `[MetaCAPI] sent ${ev.eventName} event_id=${ev.eventId} pixel=${ev.pixelId} ` +
          `received=${data?.events_received ?? '?'}`,
      );
      return {
        ok: true,
        eventsReceived: Number(data?.events_received ?? 0),
        fbTraceId: data?.fbtrace_id,
      };
    } catch (e: any) {
      const status = e?.response?.status;
      const fbError = e?.response?.data?.error;
      const message = fbError?.message ?? e?.message ?? 'CAPI request failed';

      // 4xx means Meta rejected the request itself — a bad token, a pixel we
      // have no access to, a malformed body. Retrying sends the same broken
      // request forever, so fail fast and surface it. 429 is the exception:
      // that is rate limiting and does clear. Everything else (5xx, network,
      // timeout) is transient.
      const retryable = status === 429 || !status || status >= 500;

      this.logger.error(
        `[MetaCAPI] FAILED ${ev.eventName} event_id=${ev.eventId} pixel=${ev.pixelId} ` +
          `status=${status ?? '-'} retryable=${retryable}: ${message}`,
      );
      return { ok: false, error: `${status ?? 'ERR'}: ${message}`.slice(0, 500), retryable };
    }
  }
}

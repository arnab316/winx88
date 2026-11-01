import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { OroplayTokenCache } from './token-cache.service';
import {
  OroplayResponse,
  Vendor,
  Game,
  LaunchUrlArgs,
  BettingHistory,
  HistoryByDateResponse,
  ActiveUser,
} from './dto/outbound.dto';

/**
 * OUTBOUND client — YOU call OroPlay.
 *
 * All endpoints under {OROPLAY_API_ENDPOINT}/...
 * Auth: Bearer {token} obtained via OroplayTokenCache.
 *
 * OroPlay responds with { success, message, errorCode }.
 * success === true && errorCode === 0 means success.
 */
@Injectable()
export class OroplayClient {
  private readonly logger = new Logger(OroplayClient.name);
  private readonly baseUrl: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly tokenCache: OroplayTokenCache,
  ) {
    this.baseUrl = this.config.get<string>('OROPLAY_API_ENDPOINT')!;
    if (!this.baseUrl) {
      this.logger.warn('OROPLAY_API_ENDPOINT not set — OroPlay client will fail');
    }
  }

  /** Render an upstream response body for a log line, never throwing. */
  private describe(data: unknown): string {
    if (data === undefined || data === null || data === '') return '';
    if (typeof data === 'string') return ` — ${data}`;
    try {
      return ` — ${JSON.stringify(data).slice(0, 500)}`;
    } catch {
      return ` — ${String(data)}`;
    }
  }

  private async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    retry = true,
  ): Promise<OroplayResponse<T>> {
    // Fetched OUTSIDE the try below, because the 401 handler in it means
    // "the API rejected our token, get a fresh one" — and that is the wrong
    // response to /auth/createtoken itself answering 401.
    //
    // While this was inside, a 401 from the token endpoint was read as a
    // stale token: invalidate() threw away a cached token that could still
    // have served, and the retry fired a SECOND createtoken. So every call
    // cost two requests against an endpoint that allows one per ten seconds,
    // which is the opposite of what the retry was for.
    let token: string;
    try {
      token = await this.tokenCache.getToken();
    } catch (err: any) {
      this.logger.error(
        `OroPlay request [${path}] could not get a token: ${err.message}` +
          `${this.describe(err.response?.data)}`,
      );
      throw err;
    }

    try {
      const cfg = {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      };

      const { data } =
        method === 'POST'
          ? await firstValueFrom(this.http.post(`${this.baseUrl}${path}`, body ?? {}, cfg))
          : await firstValueFrom(this.http.get(`${this.baseUrl}${path}`, cfg));

      if (!data.success || data.errorCode !== 0) {
        throw new BadRequestException(
          `OroPlay API error [${path}]: ${JSON.stringify(data.message)} (errorCode=${data.errorCode})`,
        );
      }
      return data as OroplayResponse<T>;
    } catch (err: any) {
      const status = err.response?.status;

      // The API rejected our token — it is stale. Safe to invalidate and
      // retry once: this 401 came from `path`, not from createtoken.
      if (status === 401 && retry) {
        this.logger.warn(`Got 401 from OroPlay [${path}], refreshing the token and retrying...`);
        this.tokenCache.invalidate();
        return this.request<T>(method, path, body, false);
      }

      // Nest's Logger reads the 2nd argument as a stack trace and the formatter
      // prints it *instead of* the message, so passing the response body here
      // lost the path — and when the body was undefined it printed an empty
      // line, which is why token failures showed up as bare "error:" with no
      // text at all. Fold the body into the message instead.
      this.logger.error(
        `OroPlay request failed [${path}]: ${err.message}${this.describe(err.response?.data)}`,
      );
      throw err;
    }
  }

  // ─── User (Transfer API) ─────────────────────────────────────
  /**
   * Register a player on OroPlay. userCode is whatever you choose —
   * we use the player's username. OroPlay returns success/error only;
   * the userCode itself is your identifier going forward.
   *
   * If user already exists, OroPlay returns errorCode=1 (USER_ALREADY_EXISTS).
   * Caller should treat that as idempotent success.
   */
  createUser(userCode: string) {
    return this.request<string>('POST', '/user/create', { userCode });
  }

  getUserBalance(userCode: string) {
    return this.request<number>('POST', '/user/balance', { userCode });
  }

  // ─── Wallet (Balance Transfer API) ───────────────────────────
  deposit(userCode: string, balance: number, orderNo?: string, vendorCode?: string) {
    return this.request<number>('POST', '/user/deposit', {
      userCode, balance, orderNo, vendorCode,
    });
  }

  withdraw(userCode: string, balance: number, orderNo?: string, vendorCode?: string) {
    return this.request<number>('POST', '/user/withdraw', {
      userCode, balance, orderNo, vendorCode,
    });
  }

  withdrawAll(userCode: string, vendorCode?: string) {
    return this.request<number>('POST', '/user/withdraw-all', { userCode, vendorCode });
  }

  getBalanceHistory(orderNo: string) {
    return this.request('POST', '/user/balance-history', { orderNo });
  }

  // ─── Vendor / Game catalog ───────────────────────────────────
  /**
   * The vendor catalogue, cached in memory.
   *
   * Both /oroplay/vendors and /oroplay/vendors/grouped called this live on
   * every request, so every player opening the lobby cost one upstream call
   * — and, whenever the token cache missed, one `createtoken` as well. That
   * is what put the account over OroPlay's "1 per 10s" quota and turned the
   * whole lobby into a 500.
   *
   * The list changes when a vendor is added, which is weeks apart, so a short
   * TTL costs nothing. The last good list is also kept and served if a later
   * refresh fails: a lobby showing a slightly old vendor list beats a lobby
   * showing nothing.
   */
  private vendorCache: { at: number; res: OroplayResponse<Vendor[]> } | null = null;
  private vendorInFlight: Promise<OroplayResponse<Vendor[]>> | null = null;
  private static readonly VENDOR_TTL_MS = 5 * 60 * 1000;

  async vendorList(): Promise<OroplayResponse<Vendor[]>> {
    const now = Date.now();
    if (this.vendorCache && now - this.vendorCache.at < OroplayClient.VENDOR_TTL_MS) {
      return this.vendorCache.res;
    }

    // Collapse a burst of lobby loads into one upstream call.
    if (!this.vendorInFlight) {
      this.vendorInFlight = this.request<Vendor[]>('GET', '/vendors/list')
        .then((res) => {
          this.vendorCache = { at: Date.now(), res };
          return res;
        })
        .finally(() => {
          this.vendorInFlight = null;
        });
    }

    try {
      return await this.vendorInFlight;
    } catch (err) {
      if (this.vendorCache) {
        this.logger.warn(
          `OroPlay vendor list refresh failed, serving the cached list: ${(err as Error).message}`,
        );
        return this.vendorCache.res;
      }
      throw err;
    }
  }

  gameList(vendorCode: string, language = 'en') {
    return this.request<Game[]>('POST', '/games/list', { vendorCode, language });
  }

  gameDetail(vendorCode: string, gameCode: string) {
    return this.request<Game>('POST', '/game/detail', { vendorCode, gameCode });
  }

  // ─── Game launch ─────────────────────────────────────────────
  getLaunchUrl(args: LaunchUrlArgs) {
    return this.request<string>('POST', '/game/launch-url', {
      language: 'en',
      ...args,
    });
  }

  // ─── Agent ───────────────────────────────────────────────────
  getAgentBalance() {
    return this.request<number>('GET', '/agent/balance');
  }

  // ─── Betting History ─────────────────────────────────────────
  getHistoryById(id: number) {
    return this.request<BettingHistory>('POST', '/betting/history/by-id', { id });
  }

  /**
   * NOTE: Rate-limited to 1 request per second.
   * History up to 7 days. Max 5000 records per call. Paginate via nextStartDate.
   */
  getHistoryByDate(startDate: string, limit = 5000) {
    return this.request<HistoryByDateResponse>(
      'POST', '/betting/history/by-date-v2',
      { startDate, limit },
    );
  }

  getHistoryDetailUrl(id: number, language = 'en') {
    return this.request<string>('POST', '/betting/history/detail', { id, language });
  }

  // ─── RTP ─────────────────────────────────────────────────────
  setUserRtp(vendorCode: string, userCode: string, rtp: number) {
    return this.request('POST', '/game/user/set-rtp', { vendorCode, userCode, rtp });
  }

  getUserRtp(vendorCode: string, userCode: string) {
    return this.request<number>('POST', '/game/user/get-rtp', { vendorCode, userCode });
  }

  resetUsersRtp(vendorCode: string, rtp: number) {
    return this.request('POST', '/game/users/reset-rtp', { vendorCode, rtp });
  }

  /**
   * Bulk RTP update. Max 500 users per call, rate-limited to 1 request per 3 seconds.
   */
  batchSetUserRtp(vendorCode: string, data: Array<{ userCode: string; rtp: number }>) {
    return this.request('POST', '/game/users/batch-rtp', { vendorCode, data });
  }

  // ─── Active Users / Call feature ─────────────────────────────
  getActiveUsers() {
    return this.request<ActiveUser[]>('GET', '/call/active-users');
  }

  sendCall(args: {
    vendorCode: string;
    gameCode: string;
    userCode: string;
    amount: number;
    type: number;
  }) {
    return this.request<number>('POST', '/call/send', args);
  }

  cancelCall(args: {
    vendorCode: string;
    gameCode: string;
    userCode: string;
    callId: number;
  }) {
    return this.request('POST', '/call/cancel', args);
  }

  getCallHistories(pageIndex: number, pageSize = 100) {
    return this.request('POST', '/call/histories', { pageIndex, pageSize });
  }
}

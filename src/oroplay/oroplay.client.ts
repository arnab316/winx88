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

  private async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    retry = true,
  ): Promise<OroplayResponse<T>> {
    try {
      const token = await this.tokenCache.getToken();
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

      // Token might be stale — invalidate and retry once
      if (status === 401 && retry) {
        this.logger.warn(`Got 401 from OroPlay, invalidating token and retrying...`);
        this.tokenCache.invalidate();
        return this.request<T>(method, path, body, false);
      }

      this.logger.error(
        `OroPlay request failed [${path}]: ${err.message}`,
        err.response?.data,
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
  vendorList() {
    return this.request<Vendor[]>('GET', '/vendors/list');
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

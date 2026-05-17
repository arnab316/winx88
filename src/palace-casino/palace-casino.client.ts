import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * OUTBOUND client — YOU call Palace Casino.
 *
 * All endpoints under {SLOT_API_ENDPOINT}/v4/...
 * Auth: Bearer {SLOT_API_TOKEN}
 *
 * Palace responds with { code, message, data }.
 * code === 0 means success; anything else is an error.
 */
@Injectable()
export class PalaceCasinoClient {
  private readonly logger = new Logger(PalaceCasinoClient.name);
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>('SLOT_API_ENDPOINT')!;
    this.token = this.config.get<string>('SLOT_API_TOKEN')!;
    console.log('SLOT_API_ENDPOINT loaded:', this.baseUrl);
     console.log('SLOT_API_TOKEN loaded:', this.token);

    if (!this.baseUrl || !this.token) {
      this.logger.warn(
        'SLOT_API_ENDPOINT or SLOT_API_TOKEN not set — Palace client will fail',
      );
    }
  }

  private async post<T = any>(path: string, body: any): Promise<T> {
    try {
      const { data } = await firstValueFrom(
        this.http.post(`${this.baseUrl}${path}`, body, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
        }),
      );

      if (data.code !== 0) {
        throw new BadRequestException(
          `Palace API error [${path}]: ${data.message ?? 'unknown'} (code=${data.code})`,
        );
      }
      return data as T;
    } catch (err: any) {
     this.logger.error(
    `Palace API failed [${path}]: ${JSON.stringify(err.response ?? err.message)}`
  );
  this.logger.error(`Status: ${err.response?.status} | URL: ${this.baseUrl}${path}`);
  this.logger.error(`Token used: ${this.token?.slice(0, 8)}...`);
      throw err;
    }
  }

  // ─── 1. Agent ───────────────────────────────────────────────────────────
  agentInfo() {
    return this.post('/v4/agent/info', {});
  }

  changeRtp(provider_id: number, game_code: string, rtp: number) {
    return this.post('/v4/agent/rtp', { provider_id, game_code, rtp });
  }

  // ─── 2. User ────────────────────────────────────────────────────────────
  /**
   * Create a Palace user. Pass any unique name; Palace returns a user_code.
   * Save that user_code in palace_user_mapping — it's how all future calls
   * reference this user.
   */
  createUser(name: string) {
    return this.post<{ code: number; message: string; data: { user_code: number } }>(
      '/v4/user/create',
      { name },
    );
  }

  userInfo(user_code: number) {
    return this.post('/v4/user/info', { user_code });
  }

  // ─── 3. Wallet (Transfer mode) ──────────────────────────────────────────
  /** Add funds to a Palace user's wallet. */
  deposit(user_code: number, amount: number) {
    return this.post<{ code: number; message: string; data: { balance: number; amount: number } }>(
      '/v4/wallet/deposit',
      { user_code, amount },
    );
  }

  /**
   * Withdraw a specific amount.
   * NOTE: Palace's Postman collection shows this URL as /v4/wallet/deposit (likely
   * a copy-paste error in their docs). The logical path is /v4/wallet/withdraw —
   * confirm with Palace support before going live.
   */
  withdraw(user_code: number, amount: number) {
    return this.post<{ code: number; message: string; data: { balance: number; amount: number } }>(
      '/v4/wallet/withdraw',
      { user_code, amount },
    );
  }

  /** Withdraw entire balance (used when player exits the game). */
  withdrawAll(user_code: number) {
    return this.post('/v4/wallet/withdraw-all', { user_code });
  }

  // ─── 4. Game catalog ────────────────────────────────────────────────────
  providerList(lang = 1) {
    return this.post<{ code: number; message: string; data: any[] }>(
      '/v4/game/providers',
      { lang },
    );
  }

  gameList(provider_id: number, lang = 1) {
    return this.post<{ code: number; message: string; data: any[] }>(
      '/v4/game/games',
      { provider_id, lang },
    );
  }

  // ─── 5. Game launch ─────────────────────────────────────────────────────
  /**
   * Generate the iframe URL the player loads to play a game.
   * return_url: where Palace sends the player after they close the game.
   */
  generateGameUrl(args: {
    user_code: number;
    provider_id: number;
    game_symbol: string;
    return_url: string;
    lang?: number;
    win_ratio?: number;
  }) {
    return this.post<{ code: number; message: string; data: { game_url: string } }>(
      '/v4/game/game-url',
      { lang: 1, win_ratio: 0, ...args },
    );
  }

  onlineGames() {
    return this.post('/v4/game/online-games', {});
  }

  // ─── Bonus Call feature ─────────────────────────────────────────────────
  getBonusCallConfig() {
    // NOTE: Palace's Postman has a typo — /call_cionfig. Confirm correct path.
    return this.post('/v4/game/call_config', {});
  }

  startBonusCall(args: any) {
    return this.post('/v4/game/call_start', args);
  }

  cancelBonusCall(args: any) {
    return this.post('/v4/game/call_cancel', args);
  }

  // ─── 6. Transactions ────────────────────────────────────────────────────
  getTransactions(filters: {
    user_code?: number;
    provider_id?: number;
    start_date?: string;
    end_date?: string;
    page?: number;
    page_size?: number;
  }) {
    return this.post('/v4/game/transaction', filters);
  }

  getTransactionById(trans_guid: string) {
    return this.post('/v4/game/transaction-id', { trans_guid });
  }
}

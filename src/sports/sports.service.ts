import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { DataSource, QueryRunner } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import * as querystring from 'querystring';
import axios from 'axios';
import { v4 as createUUid } from 'uuid';
import { WalletGateway } from '../wallet/wallet.gateway';
import {
  GetMiniBalanceDTO,
  MiniBetWinDTO,
  MiniDepositDTO,
  MiniWithdrawDTO,
} from './dto/minicallback.dto';
import { SlotGameCallbackDataDTO } from './dto/slotgamecallback.dto';
import { SportsCallbackDataDTO } from './dto/sportscallback.dto';
import { TurnoverService } from '../turnover/turnover.service';
import { NexusService } from '../nexus/nexus.service';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSlotConfig(token: string) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}

function getCasinoConfig(
  headers: any,
  requestParams: any,
  merchantKey: string,
  method = 'get',
) {
  const combined = { ...headers, ...requestParams };
  const sortedKeys = Object.keys(combined).sort();
  const sortedParams: any = {};
  for (const key of sortedKeys) {
    sortedParams[key] = combined[key];
  }

  const queryString = querystring.stringify(sortedParams);
  const hmac = crypto.createHmac('sha1', merchantKey);
  hmac.update(queryString);
  const signature = hmac.digest('hex');

  return {
    headers: {
      ...headers,
      'X-Sign': signature,
      'Content-Type':
        method === 'post'
          ? 'application/x-www-form-urlencoded'
          : 'application/json',
    },
  };
}

@Injectable()
export class SportsService {
  private readonly logger = new Logger(SportsService.name);

  // Last sports callback the provider sent us, recorded in-memory (resets on
  // restart). The key signal for "is the provider actually reaching us": if this
  // is null, NO callback has arrived — the provider's callback URL is wrong/
  // unreachable. Surfaced via GET /sports/admin/callback-info.
  private lastSportsCallback: {
    at: string;
    reqId: string;
    command: string;
    userName: string;
    code: number | null;
    note: string;
  } | null = null;
  private readonly casinoInfo: {
    apiUrl: string;
    merchantID: string;
    merchantKey: string;
    callbackToken: string;
  };
  private readonly slotInfo: {
    apiUrl: string;
    apiToken: string;
    callbackToken: string;
  };
  private readonly spotsInfo: {
    apiUrl: string;
    apiToken: string;
    callbackToken: string;
  };
  private readonly oroplayInfo: {
    apiUrl: string;
    clientId: string;
    clientSecret: string;
  };
  private readonly miniInfo: {
    endpoint: string;
    apiToken: string;
    callbackToken: string;
  };
  private readonly nounce = 'e115cf0f66a645aca08225c9c1b20b81';

  // OroPlay token cache
  private oroplayToken = '';
  private oroplayTokenExpiration = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly dataSource: DataSource,
    private readonly walletGateway: WalletGateway,
    private readonly turnoverService: TurnoverService,
    // Nexus games share this catalog, so the shared launch path needs to reach
    // its client. forwardRef: NexusModule imports WalletModule, which SportsModule also pulls in.
    @Inject(forwardRef(() => NexusService))
    private readonly nexusService: NexusService,
  ) {
    this.casinoInfo = {
      apiUrl:
        this.configService.get<string>('CASINO_API_URL') ??
        'https://api.slotegrator.com',
      merchantID: this.configService.get<string>('CASINO_MERCHANT_ID') ?? '',
      merchantKey: this.configService.get<string>('CASINO_MERCHANT_KEY') ?? '',
      callbackToken:
        this.configService.get<string>('CASINO_CALLBACK_TOKEN') ?? '',
    };
    this.slotInfo = {
      apiUrl:
        this.configService.get<string>('SLOT_API_ENDPOINT') ??
        'https://agent.goldslotpalase.com',
      apiToken: this.configService.get<string>('SLOT_API_TOKEN') ?? '',
      callbackToken:
        this.configService.get<string>('SLOT_CALLBACK_TOKEN') ?? '',
    };
    this.spotsInfo = {
      apiUrl:
        this.configService.get<string>('SPORTS_API_URL') ??
        'https://sportsapi.needforspeedau.com/sportsAPI',
      apiToken: this.configService.get<string>('SPORTS_API_TOKEN') ?? '',
      callbackToken:
        this.configService.get<string>('SPORTS_CALLBACK_TOKEN') ?? '',
    };
    this.oroplayInfo = {
      apiUrl:
        this.configService.get<string>('OROPLAY_API_ENDPOINT') ??
        'https://bs.sxvwlkohlv.com/api/v2',
      clientId:
        this.configService.get<string>('OROPLAY_CLIENT_ID') ?? 'Dark_BDT',
      clientSecret:
        this.configService.get<string>('OROPLAY_CLIENT_SECRET') ?? '',
    };
    this.miniInfo = {
      endpoint:
        this.configService.get<string>('MINI_API_URL') ??
        'https://miniback.betjoyful.com/api',
      apiToken: this.configService.get<string>('MINI_API_TOKEN') ?? '',
      callbackToken:
        this.configService.get<string>('MINI_CALLBACK_TOKEN') ?? '',
    };
  }

  async initDemo(demoReq: any) {
    try {
      const apiEndpoint = `${this.casinoInfo.apiUrl}/games/init-demo`;
      const unixNow = Math.floor(new Date().getTime() / 1000);
      const headers = {
        'X-Merchant-Id': this.casinoInfo.merchantID,
        'X-Timestamp': unixNow,
        'X-Nonce': this.nounce,
      };
      const requestParams = demoReq;
      const { data } = await firstValueFrom(
        this.httpService.post(
          apiEndpoint,
          demoReq,
          getCasinoConfig(
            headers,
            requestParams,
            this.casinoInfo.merchantKey,
            'post',
          ),
        ),
      );
      return data;
    } catch (error: any) {
      this.logger.error(
        `casinoInitDemo ::: ${error?.response?.data?.message ?? error.message}`,
      );
      return null;
    }
  }

  async getCasinoGames(query: any, _userPayload: any, isMobile: string) {
    const page = query?.pageable?.page ? Number(query.pageable.page) : 1;
    const size = query?.pageable?.size ? Number(query.pageable.size) : 1000;
    const offset = (page - 1) * size;

    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    // Mobile filter
    if (isMobile === 'true') {
      conditions.push(`is_mobile = 1`);
    } else {
      conditions.push(
        `((name NOT ILIKE '%Mobile%' AND is_mobile = 0) OR (name NOT ILIKE '%Mobile%' AND is_mobile = 1))`,
      );
    }

    // RTP filter
    if (query?.filters?.is_rtp) {
      conditions.push(
        `parameters IS NOT NULL AND (parameters->>'rtp') IS NOT NULL`,
      );
    }

    // Search filter
    if (query?.search) {
      conditions.push(`name ILIKE $${paramIndex++}`);
      values.push(`%${query.search}%`);
    }

    // Type filter
    if (query?.filters?.type) {
      if (query.filters.type === 'live') {
        conditions.push(
          `type NOT IN ('slots', 'instant') AND vendor_code IS NOT NULL`,
        );
      } else {
        conditions.push(`type = $${paramIndex++}`);
        values.push(query.filters.type);
      }
    }

    // New filter
    if (query?.filters?.is_new !== undefined) {
      conditions.push(`is_new = $${paramIndex++}`);
      values.push(
        query.filters.is_new === 'true' || query.filters.is_new === true,
      );
    }

    // Providers filter
    if (
      query?.filters?.providers &&
      Array.isArray(query.filters.providers) &&
      query.filters.providers.length > 0
    ) {
      conditions.push(`provider = ANY($${paramIndex++})`);
      values.push(query.filters.providers);
    }

    // Has tables filter
    if (query?.filters?.has_tables !== undefined) {
      conditions.push(`has_tables = $${paramIndex++}`);
      values.push(Number(query.filters.has_tables));
    }

    const whereClause =
      conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countQuery = `SELECT COUNT(*)::int AS total FROM casino_games ${whereClause}`;
    const dataQuery = `SELECT * FROM casino_games ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;

    const countResult = await this.dataSource.query(countQuery, values);
    const dataResult = await this.dataSource.query(dataQuery, [
      ...values,
      size,
      offset,
    ]);

    return {
      items: dataResult,
      total: countResult[0]?.total ?? 0,
    };
  }

  async getLiveVendors() {
    const rows = await this.dataSource.query(
      `SELECT DISTINCT provider FROM casino_games 
       WHERE vendor_code IS NOT NULL AND type NOT IN ('slots', 'instant') 
       ORDER BY provider ASC`,
    );
    return rows.map((r: any) => r.provider);
  }

  async getSportsLink(
    _query: any,
    userPayload: any,
    _isMobile: string,
    language?: string,
  ) {
    if (!userPayload) return null;

    try {
      const SPORTS_SUPPORTED_LANGS = ['en', 'fr', 'fa', 'ar', 'tr'];
      const sportsLang = SPORTS_SUPPORTED_LANGS.includes(language ?? '')
        ? language
        : 'en';

      const userId = userPayload.sub;
      const [user] = await this.dataSource.query(
        `SELECT username FROM users WHERE id = $1`,
        [userId],
      );
      if (!user?.username) return null;

      // Provider requires name to match ^[_a-zA-Z0-9]+$ — same sanitization
      // as the slot flow. The callback handler matches both forms.
      const sportsUserName = user.username
        .replaceAll('@', '_')
        .replaceAll('.', '_');

      const sportsHeaders = {
        Authorization: `Bearer ${this.spotsInfo.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      this.logger.log(
        `[getSportsLink] userCreate request -> ${this.spotsInfo.apiUrl}/v1/user/create ` +
          `userId=${userId} dbUsername="${user.username}" sportsUserName="${sportsUserName}" ` +
          `apiToken=${this.maskSecret(this.spotsInfo.apiToken)}`,
      );

      const { data: createUserRes } = await axios.post<any>(
        `${this.spotsInfo.apiUrl}/v1/user/create`,
        { name: sportsUserName },
        { headers: sportsHeaders },
      );

      this.logger.log(`[getSportsLink] userCreate response ${this.safeJson(createUserRes)}`);

      if (!createUserRes?.data?.userCode) {
        this.logger.error(`[getSportsLink] userCode missing from userCreate response`);
        return null;
      }

      this.logger.log(
        `[getSportsLink] gameUrl request -> ${this.spotsInfo.apiUrl}/v1/game/game-url ` +
          `userCode=${createUserRes.data.userCode} language=${sportsLang}`,
      );

      const { data } = await axios.post<any>(
        `${this.spotsInfo.apiUrl}/v1/game/game-url`,
        { userCode: createUserRes.data.userCode, language: sportsLang },
        { headers: sportsHeaders },
      );

      this.logger.log(`[getSportsLink] gameUrl response ${this.safeJson(data)}`);
      return data?.data?.gameUrl ?? null;
    } catch (error: any) {
      this.logger.error(
        `Error in getSportsLink: ${error?.response?.data ? JSON.stringify(error.response.data) : error?.message}`,
      );
      return null;
    }
  }

  async getAuthGames(query: any, userPayload: any, isMobile: string) {
    const userId = userPayload.sub;
    const userRows = await this.dataSource.query(
      `SELECT * FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) return { items: [], total: 0 };
    const user = userRows[0];

    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (isMobile === 'true') {
      conditions.push(`is_mobile = 1`);
    } else {
      conditions.push(
        `((name NOT ILIKE '%Mobile%' AND is_mobile = 0) OR (name NOT ILIKE '%Mobile%' AND is_mobile = 1))`,
      );
    }

    if (query?.search) {
      conditions.push(`name ILIKE $${paramIndex++}`);
      values.push(`%${query.search}%`);
    }

    if (
      query?.filters?.providers &&
      Array.isArray(query.filters.providers) &&
      query.filters.providers.length > 0
    ) {
      conditions.push(`provider = ANY($${paramIndex++})`);
      values.push(query.filters.providers);
    }

    if (query?.filters?.isLike) {
      const likes = user.casino_like ?? user.casinoLike ?? [];
      if (likes.length > 0) {
        conditions.push(`uuid = ANY($${paramIndex++})`);
        values.push(likes);
      } else {
        return { items: [], total: 0 };
      }
    }

    if (query?.filters?.isRecent) {
      const recents = user.casino_recent ?? user.casinoRecent ?? [];
      if (recents.length > 0) {
        conditions.push(`uuid = ANY($${paramIndex++})`);
        values.push(recents);
      } else {
        return { items: [], total: 0 };
      }
    }

    const whereClause =
      conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const items = await this.dataSource.query(
      `SELECT * FROM casino_games ${whereClause}`,
      values,
    );
    const total = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM casino_games ${whereClause}`,
      values,
    );

    return {
      items,
      total: total[0]?.total ?? 0,
    };
  }

  async getGameUrl(
    uuid: string,
    query: any,
    userPayload: any,
    isMobile: string,
  ) {
    this.logger.log(
      `[getGameUrl] START - uuid: ${uuid}, user: ${userPayload?.sub}, isMobile: ${isMobile}, searchType: ${query?.searchType}`,
    );

    const games = await this.dataSource.query(
      `SELECT * FROM casino_games WHERE uuid = $1 LIMIT 1`,
      [uuid],
    );
    if (!games.length) {
      throw new HttpException('Game not found', HttpStatus.NOT_FOUND);
    }
    const game = games[0];

    this.logger.log(
      `[getGameUrl] game found: true, name: ${game?.name}, type: ${game?.type}, provider: ${game?.provider}, provider_id: ${game?.provider_id}, game_symbol: ${game?.game_symbol}`,
    );

    if (isMobile === 'true') {
      if (!game.is_mobile && game.name.includes('Mobile')) {
        throw new HttpException(
          { code: 400, message: `Don't support in Mobile` },
          HttpStatus.BAD_REQUEST,
        );
      }
    } else {
      if (game.name.includes('Mobile') && !game.is_mobile) {
        throw new HttpException(
          { code: 400, message: `Don't support in Desktop` },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const userId = userPayload.sub;
    const userRows = await this.dataSource.query(
      `SELECT username, email FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }
    const user = userRows[0];

    if (query?.searchType === 'real') {
      // Nexus is checked FIRST and by aggregator, not by type: its catalog
      // contains slots as well as live games, so a type-based check further
      // down would route a Nexus slot into the Palace flow and fail.
      if (game.aggregator === 'NEXUS') {
        this.logger.log(
          `[getGameUrl] NEXUS path - provider: ${game.vendor_code}, game: ${game.game_code}`,
        );
        try {
          return await this.nexusService.getLaunchUrl(userId, uuid, 'en');
        } catch (error: any) {
          this.logger.error(`[getGameUrl] NEXUS error: ${error?.message}`);
          return null;
        }
      }

      if (
        game.type === 'slots' ||
        game.provider === 'Spribe' ||
        game.provider === 'Tydo'
      ) {
        this.logger.log(
          `[getGameUrl] SLOT/Spribe/Tydo path - checking slot user: ${user.username}`,
        );
        const checkSlotGameUser = await this.checkSlotGameUser(user.username);
        this.logger.log(
          `[getGameUrl] checkSlotGameUser result: ${JSON.stringify(checkSlotGameUser)}`,
        );
        if (!checkSlotGameUser) return null;
        try {
          const apiEndpoint = `${this.slotInfo.apiUrl}/v4/game/game-url`;
          const requestBody = {
            user_code: checkSlotGameUser?.data?.user_code,
            provider_id: game.provider_id,
            game_symbol: game.game_symbol,
            lang: game.lang,
            return_url: process.env.LOBBY_URL || 'https://lobby.slotcity.com',
            win_ratio: 0,
          };
          this.logger.log(
            `[getGameUrl] SLOT API request - endpoint: ${apiEndpoint}, body: ${JSON.stringify(requestBody)}`,
          );
          const { data } = await firstValueFrom(
            this.httpService.post(
              apiEndpoint,
              requestBody,
              getSlotConfig(this.slotInfo.apiToken),
            ),
          );
          this.logger.log(
            `[getGameUrl] SLOT API response: ${JSON.stringify(data)}`,
          );
          return { url: data?.data?.game_url };
        } catch (ex: any) {
          this.logger.error(
            `[getGameUrl] SLOT API error: ${ex?.message}, response: ${JSON.stringify(ex?.response?.data)}`,
          );
          return null;
        }
      }
      // ── MINI GAME launch disabled ────────────────────────────────────────
      // else if (game.type === 'instant' && game.provider !== 'Spribe') {
      //   this.logger.log(`[getGameUrl] INSTANT path - gameCode: ${game.game_symbol}, userId: ${userId}`);
      //   const response = await axios.post(
      //     `${this.miniInfo.endpoint}/gameurl`,
      //     {
      //       gameCode: game.game_symbol,
      //       userId: String(userId),
      //       userName: user.username,
      //       lang: 'en',
      //       lobbyurl: process.env.LOBBY_URL || 'https://lobby.slotcity.com',
      //     },
      //     {
      //       headers: {
      //         Authorization: `Bearer ${this.miniInfo.apiToken}`,
      //       },
      //       proxy: false,
      //     },
      //   );
      //   this.logger.log(`[getGameUrl] INSTANT response url: ${response.data?.data?.url}`);
      //   return { url: response.data?.data?.url };
      // }
      // ── end MINI GAME ────────────────────────────────────────────────────
      else {
        // OroPlay Live Casino
        try {
          this.logger.log(
            `[getGameUrl] LIVE (OroPlay) path - uuid: ${uuid}, user: ${user.username}`,
          );
          const launchUrl = await this.getOroPlayLaunchUrl(
            game.vendor_code,
            game.game_code,
            user.username,
            'en',
          );
          this.logger.log(`[getGameUrl] LIVE (OroPlay) launch URL received`);
          return { url: launchUrl };
        } catch (error: any) {
          this.logger.error(
            `[getGameUrl] LIVE (OroPlay) error - game: ${uuid}, message: ${error?.message}`,
          );
          return null;
        }
      }
    } else if (query?.searchType === 'demo') {
      const demoReq = {
        game_uuid: uuid,
        language: 'en',
      };
      return await this.initDemo(demoReq);
    } else {
      throw new HttpException(
        { code: 400, message: 'please select play mode' },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async getLogs(query: any, userPayload: any) {
    const page = query?.pageable?.page ? Number(query.pageable.page) : 1;
    const size = query?.pageable?.size ? Number(query.pageable.size) : 1000;
    const offset = (page - 1) * size;
    const userId = userPayload.sub;

    const conditions: string[] = ['user_id = $1'];
    const values: any[] = [userId];
    let paramIndex = 2;

    if (query?.filters?.action) {
      conditions.push(`action = $${paramIndex++}`);
      values.push(query.filters.action);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const items = await this.dataSource.query(
      `SELECT * FROM casino_game_logs ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, size, offset],
    );

    const countResult = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM casino_game_logs ${whereClause}`,
      values,
    );

    return {
      items,
      total: countResult[0]?.total ?? 0,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // SPORTSBOOK BET HISTORY (sports_bet_logs)
  //   Dedicated history for the actual sportsbook wagers (NOT the slots/casino
  //   `casino_game_logs` that getLogs returns). Mirrors the jackpot module's
  //   "my-bets" (user) + "admin bets" (admin) pattern so sports has its own
  //   user and admin panels like lottery and palace-casino do.
  //
  //   Status / payout are derived exactly like the unified game-history feed
  //   (game-history.service.ts sportsSourceSql) so both views agree:
  //     PLACED    → open slip (no settlement yet)
  //     WON/LOST  → from win_amount (the real amount credited at settlement)
  //     CANCELLED → void/refund status codes (3,6,7,8)
  // ════════════════════════════════════════════════════════════════════════

  /** Normalized column list for one sports_bet_logs row (alias sb). */
  private sportsBetColumns(): string {
    return `
      sb.id,
      sb.trans_id,
      sb.trans_hist_id,
      sb.amount::numeric                                   AS bet_amount,
      NULLIF(sb.bet_list->>'totalOdds', '')::numeric       AS total_odds,
      NULLIF(sb.bet_list->>'totalWin', '')::numeric        AS potential_win,
      COALESCE(NULLIF(sb.bet_list->'selections'->0->>'eventName', ''), 'Sportsbook') AS event_name,
      sb.bet_list->'selections'                            AS selections,
      CASE
        WHEN sb.settled_at IS NULL AND sb.trans_hist_id IS NULL THEN NULL
        WHEN sb.win_amount IS NOT NULL                          THEN sb.win_amount
        WHEN sb.type IN ('1','4','5')  THEN NULLIF(sb.bet_list->>'totalWin', '')::numeric
        WHEN sb.type IN ('3','6','7','8')                       THEN NULL
        ELSE 0
      END                                                  AS actual_payout,
      CASE
        WHEN sb.settled_at IS NULL AND sb.trans_hist_id IS NULL THEN 'PLACED'
        WHEN sb.type IN ('3','6','7','8')                       THEN 'CANCELLED'
        WHEN sb.win_amount IS NOT NULL
             THEN CASE WHEN sb.win_amount > 0 THEN 'WON' ELSE 'LOST' END
        WHEN sb.type IN ('1','4','5')                           THEN 'WON'
        ELSE 'LOST'
      END                                                  AS status,
      sb.created_at                                        AS placed_at,
      sb.settled_at                                        AS settled_at
    `;
  }

  private mapSportsBetRow(r: any) {
    return {
      id: Number(r.id),
      transId: r.trans_id,
      transHistId: r.trans_hist_id,
      eventName: r.event_name,
      betAmount: r.bet_amount === null ? null : Number(r.bet_amount),
      totalOdds: r.total_odds === null ? null : Number(r.total_odds),
      potentialWin: r.potential_win === null ? null : Number(r.potential_win),
      actualPayout: r.actual_payout === null ? null : Number(r.actual_payout),
      status: r.status,
      placedAt: r.placed_at,
      settledAt: r.settled_at,
      selections: r.selections ?? null,
    };
  }

  /**
   * USER panel: the logged-in user's own sportsbook bets.
   * Filters: status (WON|LOST|PLACED|CANCELLED), from, to (whole-day inclusive).
   */
  async getSportsBetHistory(
    userId: number,
    query: { status?: string; from?: string; to?: string; page?: number; limit?: number },
  ) {
    const page = Math.max(Number(query?.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query?.limit) || 20, 1), 100);
    const offset = (page - 1) * limit;

    this.logger.log(
      `[SportsBetHistory] user=${userId} status=${query?.status ?? '-'} ` +
        `from=${query?.from ?? '-'} to=${query?.to ?? '-'} page=${page} limit=${limit}`,
    );

    // Inner filters (user + date) — applied on the raw row.
    const inner: string[] = ['sb.user_id = $1'];
    const params: any[] = [userId];
    let i = 2;
    if (query?.from) {
      inner.push(`sb.created_at >= $${i++}`);
      params.push(query.from);
    }
    if (query?.to) {
      inner.push(`sb.created_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(query.to);
    }
    const innerWhere = `WHERE ${inner.join(' AND ')}`;
    const innerSql = `SELECT ${this.sportsBetColumns()} FROM sports_bet_logs sb ${innerWhere}`;

    // Outer status filter (status is a derived column).
    const status = query?.status?.toUpperCase();
    const outerWhere = status ? `WHERE h.status = $${i++}` : '';
    if (status) params.push(status);

    const rows = await this.dataSource.query(
      `SELECT * FROM (${innerSql}) h
       ${outerWhere}
       ORDER BY h.placed_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limit, offset],
    );

    const [stats] = await this.dataSource.query(
      `SELECT
         COUNT(*)::int                                            AS total_bets,
         COUNT(*) FILTER (WHERE h.status = 'WON')::int            AS total_wins,
         COUNT(*) FILTER (WHERE h.status = 'LOST')::int           AS total_losses,
         COUNT(*) FILTER (WHERE h.status = 'PLACED')::int         AS total_pending,
         COUNT(*) FILTER (WHERE h.status = 'CANCELLED')::int      AS total_cancelled,
         COALESCE(SUM(h.bet_amount), 0)::numeric                  AS total_staked,
         COALESCE(SUM(h.actual_payout) FILTER (WHERE h.status = 'WON'), 0)::numeric AS total_won
       FROM (${innerSql}) h ${outerWhere}`,
      params,
    );

    const total = stats?.total_bets ?? 0;
    const totalStaked = Number(stats?.total_staked ?? 0);
    const totalWon = Number(stats?.total_won ?? 0);

    this.logger.log(
      `[SportsBetHistory] user=${userId} returned rows=${rows.length} total=${total} ` +
        `staked=${totalStaked} won=${totalWon}` +
        (total === 0 ? ' (no sportsbook bets in range — check sportsCallback logs if unexpected)' : ''),
    );

    return {
      data: rows.map((r: any) => this.mapSportsBetRow(r)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
      summary: {
        totalBets: stats?.total_bets ?? 0,
        totalWins: stats?.total_wins ?? 0,
        totalLosses: stats?.total_losses ?? 0,
        totalPending: stats?.total_pending ?? 0,
        totalCancelled: stats?.total_cancelled ?? 0,
        totalStaked,
        totalWon,
        netPL: Number((totalWon - totalStaked).toFixed(2)),
      },
    };
  }

  /**
   * ADMIN panel: sportsbook bets across players.
   * Filters: userId, username (ILIKE), status, from, to. Each row carries the
   * player's username / user_code / full_name for display.
   */
  async getAdminSportsBetHistory(query: {
    userId?: number;
    username?: string;
    status?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(Number(query?.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query?.limit) || 20, 1), 200);
    const offset = (page - 1) * limit;

    this.logger.log(
      `[AdminSportsBetHistory] userId=${query?.userId ?? '-'} username=${query?.username ?? '-'} ` +
        `status=${query?.status ?? '-'} from=${query?.from ?? '-'} to=${query?.to ?? '-'} ` +
        `page=${page} limit=${limit}`,
    );

    const inner: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (query?.userId) {
      inner.push(`sb.user_id = $${i++}`);
      params.push(query.userId);
    }
    if (query?.username) {
      inner.push(`u.username ILIKE $${i++}`);
      params.push(`%${query.username}%`);
    }
    if (query?.from) {
      inner.push(`sb.created_at >= $${i++}`);
      params.push(query.from);
    }
    if (query?.to) {
      inner.push(`sb.created_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(query.to);
    }
    const innerWhere = inner.length ? `WHERE ${inner.join(' AND ')}` : '';
    const innerSql = `
      SELECT
        ${this.sportsBetColumns()},
        sb.user_id                                         AS user_id,
        u.username                                         AS username,
        u.user_code                                        AS user_code,
        u.full_name                                        AS full_name
      FROM sports_bet_logs sb
      LEFT JOIN users u ON u.id = sb.user_id
      ${innerWhere}
    `;

    const status = query?.status?.toUpperCase();
    const outerWhere = status ? `WHERE h.status = $${i++}` : '';
    if (status) params.push(status);

    const rows = await this.dataSource.query(
      `SELECT *, COUNT(*) OVER() AS total_count
       FROM (${innerSql}) h
       ${outerWhere}
       ORDER BY h.placed_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limit, offset],
    );

    const total = rows.length ? Number(rows[0].total_count) : 0;
    const data = rows.map((r: any) => ({
      ...this.mapSportsBetRow(r),
      userId: r.user_id === null ? null : Number(r.user_id),
      username: r.username,
      userCode: r.user_code,
      fullName: r.full_name,
    }));

    this.logger.log(
      `[AdminSportsBetHistory] returned rows=${rows.length} total=${total}`,
    );

    return { data, page, limit, total, totalPages: Math.ceil(total / limit) || 0 };
  }

  // ════════════════════════════════════════════════════════════════════════
  // ADMIN: SPORTS CALLBACK HEALTH
  //   Confirms how the provider should reach us and whether it actually has.
  //   `lastCallbackReceived` is in-memory (resets on restart); `storage`
  //   reflects persisted bet rows. If BOTH show nothing, the provider is not
  //   reaching this server — fix the callback URL on the provider's side.
  // ════════════════════════════════════════════════════════════════════════
  async getCallbackInfo() {
    const base = (this.configService.get<string>('APP_BASE_URL') ?? '').replace(/\/+$/, '');
    const callbackUrl = base ? `${base}/sports/sportsCallback` : '/sports/sportsCallback';

    const [s] = await this.dataSource.query(
      `SELECT
         COUNT(*)::int                                          AS total_bets,
         COUNT(*) FILTER (WHERE settled_at IS NOT NULL)::int    AS total_settled,
         MAX(created_at)                                        AS last_bet_at,
         MAX(settled_at)                                        AS last_settled_at
       FROM sports_bet_logs`,
    );

    const received = !!this.lastSportsCallback;
    return {
      // What the provider must be configured to call:
      callbackUrl,
      callbackPath: '/sports/sportsCallback',
      callbackMethod: 'POST',
      expectedAuthHeader: 'Authorization: Bearer <SPORTS_CALLBACK_TOKEN>',
      callbackTokenConfigured: !!this.spotsInfo.callbackToken,
      callbackTokenMasked: this.maskSecret(this.spotsInfo.callbackToken),
      providerApiUrl: this.spotsInfo.apiUrl,

      // Has the provider actually reached us (since last restart)?
      lastCallbackReceived: this.lastSportsCallback,

      // Persisted evidence of successful bet/win callbacks:
      storage: {
        totalBets: s?.total_bets ?? 0,
        totalSettled: s?.total_settled ?? 0,
        lastBetAt: s?.last_bet_at ?? null,
        lastSettledAt: s?.last_settled_at ?? null,
      },

      healthy: received || (s?.total_bets ?? 0) > 0,
      note: received
        ? `Last callback: ${this.lastSportsCallback?.command} → code ${this.lastSportsCallback?.code ?? '?'} (${this.lastSportsCallback?.note}) at ${this.lastSportsCallback?.at}.`
        : 'NO sports callback received since last restart. The provider is not reaching this server — verify the callback URL registered on the provider matches callbackUrl above and that it is publicly reachable.',
    };
  }

  async updateLiveCasinoGames() {
    try {
      this.logger.log('[OroPlay] Starting live casino games sync...');
      const liveVendors = await this.getOroPlayLiveVendors();
      this.logger.log(
        `[OroPlay] Found ${liveVendors.length} live casino vendors`,
      );

      // Scoped away from Nexus rows: this reload clears the whole live catalog
      // by type, which would otherwise wipe every game synced from the Nexus
      // aggregator (they share this table and use the same live types).
      await this.dataSource.query(
        `DELETE FROM casino_games
          WHERE type NOT IN ('slots', 'instant')
            AND aggregator IS DISTINCT FROM 'NEXUS'`,
      );

      let totalInserted = 0;

      for (const vendor of liveVendors) {
        try {
          const games = await this.getOroPlayGamesList(vendor.vendorCode);
          for (const game of games) {
            if (game.underMaintenance) continue;

            let type = 'live';
            const nameLower = game.gameName?.toLowerCase() || '';
            if (nameLower.includes('roulette')) type = 'roulette';
            else if (nameLower.includes('baccarat')) type = 'baccarat';
            else if (nameLower.includes('blackjack')) type = 'blackjack';
            else if (
              nameLower.includes('poker') ||
              nameLower.includes('holdem')
            )
              type = 'table';

            const uuid = `${vendor.vendorCode}_${game.gameCode}`;
            await this.dataSource.query(
              `INSERT INTO casino_games 
                 (uuid, name, image, type, provider, vendor_code, game_code, slug, under_maintenance, game_symbol, lang, technology, has_lobby, is_mobile, has_freespins, has_tables, freespin_valid_until_full_day, parameters, tags, images, related_games, is_new)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
               ON CONFLICT (uuid) DO UPDATE SET
                 name = EXCLUDED.name,
                 image = EXCLUDED.image,
                 type = EXCLUDED.type,
                 provider = EXCLUDED.provider,
                 vendor_code = EXCLUDED.vendor_code,
                 game_code = EXCLUDED.game_code,
                 slug = EXCLUDED.slug,
                 under_maintenance = EXCLUDED.under_maintenance,
                 updated_at = NOW()`,
              [
                uuid,
                game.gameName,
                game.thumbnail || '',
                type,
                game.provider || vendor.name,
                vendor.vendorCode,
                game.gameCode,
                game.slug || '',
                game.underMaintenance || false,
                game.gameCode,
                1,
                'HTML5',
                game.gameCode === 'lobby' ? 1 : 0,
                1,
                0,
                0,
                0,
                JSON.stringify({
                  rtp: 95,
                  volatility: null,
                  reels_count: null,
                  lines_count: null,
                }),
                '[]',
                '[]',
                '[]',
                game.isNew || false,
              ],
            );
            totalInserted++;
          }
          await wait(500);
        } catch (vendorError: any) {
          this.logger.error(
            `[OroPlay] Error fetching games for ${vendor.vendorCode}: ${vendorError?.message}`,
          );
        }
      }

      this.logger.log(
        `[OroPlay] Live casino sync complete. Total: ${totalInserted} games`,
      );
      return {
        msg: `all games updated. Total: ${totalInserted} games from ${liveVendors.length} vendors`,
      };
    } catch (ex: any) {
      this.logger.error(
        `[OroPlay] updateLiveCasinoGames error: ${ex?.message}`,
      );
      return { msg: 'error occurred: ' + ex?.message };
    }
  }

  async getOroPlayToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.oroplayToken && this.oroplayTokenExpiration > now + 60) {
      return this.oroplayToken;
    }
    try {
      const response = await axios.post(
        `${this.oroplayInfo.apiUrl}/auth/createtoken`,
        {
          clientId: this.oroplayInfo.clientId,
          clientSecret: this.oroplayInfo.clientSecret,
        },
      );
      this.oroplayToken = response.data.token;
      this.oroplayTokenExpiration = response.data.expiration;
      this.logger.log('[OroPlay] Token refreshed successfully');
      return this.oroplayToken;
    } catch (error: any) {
      this.logger.error(`[OroPlay] Token creation failed: ${error?.message}`);
      throw error;
    }
  }

  validateOroPlayBasicAuth(authHeader: string): boolean {
    if (!authHeader || !authHeader.startsWith('Basic ')) return false;
    const decoded = Buffer.from(
      authHeader.replace('Basic ', ''),
      'base64',
    ).toString('utf-8');
    const [clientId, clientSecret] = decoded.split(':');
    return (
      clientId === this.oroplayInfo.clientId &&
      clientSecret === this.oroplayInfo.clientSecret
    );
  }

  validateMiniCallbackSign(sign: string): boolean {
    if (!this.miniInfo.callbackToken) return true;
    return sign === this.miniInfo.callbackToken;
  }

  async getOroPlayLiveVendors(): Promise<any[]> {
    const token = await this.getOroPlayToken();
    const response = await axios.get(
      `${this.oroplayInfo.apiUrl}/vendors/list`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.data.success) {
      throw new Error(
        `OroPlay vendors/list failed: errorCode=${response.data.errorCode}`,
      );
    }
    return response.data.message.filter((v: any) => v.type === 1);
  }

  async getOroPlayGamesList(
    vendorCode: string,
    language = 'en',
  ): Promise<any[]> {
    const token = await this.getOroPlayToken();
    const response = await axios.post(
      `${this.oroplayInfo.apiUrl}/games/list`,
      { vendorCode, language },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.data.success) {
      throw new Error(
        `OroPlay games/list failed for ${vendorCode}: errorCode=${response.data.errorCode}`,
      );
    }
    return response.data.message;
  }

  async getOroPlayLaunchUrl(
    vendorCode: string,
    gameCode: string,
    userCode: string,
    language = 'en',
  ): Promise<string> {
    const token = await this.getOroPlayToken();
    const response = await axios.post(
      `${this.oroplayInfo.apiUrl}/game/launch-url`,
      {
        vendorCode,
        gameCode,
        userCode,
        language,
        lobbyUrl: process.env.LOBBY_URL || 'https://xbetzone.com',
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.data.success) {
      throw new Error(
        `OroPlay launch-url failed: errorCode=${response.data.errorCode}`,
      );
    }
    return response.data.message;
  }

  async handleOroPlayBalance(userCode: string) {
    const rows = await this.dataSource.query(
      `SELECT u.id, w.balance FROM users u 
       JOIN wallets w ON w.user_id = u.id 
       WHERE u.username = $1 LIMIT 1`,
      [userCode],
    );
    if (!rows.length) {
      return { success: false, message: 0, errorCode: 2 }; // USER_DOES_NOT_EXIST
    }
    return { success: true, message: Number(rows[0].balance), errorCode: 0 };
  }

  async handleOroPlayTransaction(
    userCode: string,
    vendorCode: string,
    gameCode: string,
    _historyId: number,
    roundId: string,
    _gameType: number,
    transactionCode: string,
    _isFinished: boolean,
    isCanceled: boolean,
    amount: number,
    _detail: string,
    _createdAt: string,
  ) {
    this.logger.log(
      `[OroPlay TX] userCode=${userCode}, vendorCode=${vendorCode}, gameCode=${gameCode}, amount=${amount}, txCode=${transactionCode}, isCanceled=${isCanceled}`,
    );

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const existingTx = await qr.query(
        `SELECT id FROM casino_game_logs WHERE transaction_id = $1 LIMIT 1`,
        [transactionCode],
      );
      if (existingTx.length > 0) {
        this.logger.warn(
          `[OroPlay TX] Duplicate transaction: ${transactionCode}`,
        );
        const userWallet = await qr.query(
          `SELECT w.balance FROM users u 
           JOIN wallets w ON w.user_id = u.id 
           WHERE u.username = $1 LIMIT 1`,
          [userCode],
        );
        await qr.rollbackTransaction();
        await qr.release();
        return {
          success: false,
          message: Number(userWallet[0]?.balance ?? 0),
          errorCode: 6,
        }; // DUPLICATE_TRANSACTION
      }

      const userRows = await qr.query(
        `SELECT id, username, vip_level FROM users WHERE username = $1 LIMIT 1`,
        [userCode],
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, message: 0, errorCode: 2 }; // USER_DOES_NOT_EXIST
      }
      const user = userRows[0];

      const walletRows = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [user.id],
      );
      if (!walletRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, message: 0, errorCode: 2 };
      }
      const currentBalance = Number(walletRows[0].balance);

      if (amount < 0 && currentBalance < Math.abs(amount)) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, message: currentBalance, errorCode: 4 }; // INSUFFICIENT_USER_BALANCE
      }

      const newBalance = currentBalance + amount;

      await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
        newBalance,
        user.id,
      ]);

      const gameRows = await qr.query(
        `SELECT uuid, name, provider, type FROM casino_games 
         WHERE (vendor_code = $1 AND game_code = $2) OR uuid = $3 LIMIT 1`,
        [vendorCode, gameCode, gameCode],
      );
      const game = gameRows[0];

      const isBet = amount < 0;
      const action = isCanceled ? 'cancel' : isBet ? 'bet' : 'win';
      const absAmount = Math.abs(amount);

      const tx_id = `${user.username}_${game?.uuid ?? gameCode}_${Date.now()}`;
      const userData = {
        user_id: user.id,
        username: user.username,
        vip_level: user.vip_level,
      };

      await qr.query(
        `INSERT INTO casino_game_logs 
           (user_id, user_name, game_uuid, game_name, game_provider, game_type, action, type, amount, tx_id, transaction_id, round_id, user_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          user.id,
          user.username,
          game?.uuid ?? gameCode,
          game?.name ?? gameCode,
          game?.provider ?? vendorCode,
          game?.type ?? 'live',
          action,
          action,
          absAmount,
          tx_id,
          transactionCode,
          roundId,
          JSON.stringify(userData),
        ],
      );

      const userCashLogType = isCanceled
        ? 'CasinoRefund'
        : isBet
          ? 'CasinoBet'
          : 'CasinoWin';
      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', $6)`,
        [
          user.id,
          JSON.stringify(userData),
          absAmount,
          currentBalance,
          newBalance,
          userCashLogType,
        ],
      );

      await this.handleAffiliateCommission(
        qr,
        user.id,
        user.username,
        absAmount,
        action,
        'CASINO',
      );

      await qr.commitTransaction();
      await qr.release();

      this.walletGateway
        .pushBalanceUpdate(user.id)
        .catch((e) =>
          this.logger.warn(
            `WS push failed (oroplay tx) userId=${user.id}: ${e.message}`,
          ),
        );

      this.logger.log(
        `[OroPlay TX] Success - userCode=${userCode}, newBalance=${newBalance}`,
      );
      return { success: true, message: newBalance, errorCode: 0 };
    } catch (err: any) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error(`[OroPlay TX] Save error: ${err?.message}`);
      return { success: false, message: 0, errorCode: 7 }; // INVALID_TRANSACTION
    }
  }

  async handleOroPlayBatchTransactions(userCode: string, transactions: any[]) {
    let lastResult: any = null;
    for (const tx of transactions) {
      lastResult = await this.handleOroPlayTransaction(
        tx.userCode || userCode,
        tx.vendorCode,
        tx.gameCode,
        tx.historyId,
        tx.roundId,
        tx.gameType,
        tx.transactionCode,
        tx.isFinished,
        tx.isCanceled,
        tx.amount,
        tx.detail || '',
        tx.createdAt || '',
      );
      if (!lastResult.success && lastResult.errorCode !== 6) {
        return lastResult;
      }
    }
    return lastResult || { success: true, message: 0, errorCode: 0 };
  }

  async updateSlotGames() {
    try {
      const apiProvidersEndpoint = `${this.slotInfo.apiUrl}/v4/game/providers`;
      const apiGamesEndpoint = `${this.slotInfo.apiUrl}/v4/game/games`;
      // Same guard as the live sync above — Nexus slots live in this table too
      // and must survive a Palace catalog reload.
      await this.dataSource.query(
        `DELETE FROM casino_games
          WHERE type = 'slots'
            AND aggregator IS DISTINCT FROM 'NEXUS'`,
      );

      const providersResponse = await firstValueFrom(
        this.httpService.post(
          apiProvidersEndpoint,
          { lang: 1 },
          getSlotConfig(this.slotInfo.apiToken),
        ),
      );

      let totalInserted = 0;
      for (const provider of providersResponse.data?.data) {
        const gamesResponse = await firstValueFrom(
          this.httpService.post(
            apiGamesEndpoint,
            { provider_id: provider?.provider_id, lang: 1 },
            getSlotConfig(this.slotInfo.apiToken),
          ),
        );

        const games = gamesResponse.data?.data;
        for (const game of games) {
          const uuid = createUUid();
          await this.dataSource.query(
            `INSERT INTO casino_games 
               (uuid, name, image, type, provider, provider_id, game_symbol, lang, technology, has_lobby, is_mobile, has_freespins, has_tables, freespin_valid_until_full_day, parameters, tags, images, related_games, is_new)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
            [
              uuid,
              game?.game_name,
              game?.game_image,
              'slots',
              provider?.provider_name,
              provider?.provider_id,
              game?.game_code,
              1,
              'HTML5',
              0,
              1,
              0,
              0,
              0,
              JSON.stringify({
                rtp: 95,
                volatility: 'high',
                reels_count: 5,
                lines_count: 20,
              }),
              '[]',
              '[]',
              '[]',
              false,
            ],
          );
          totalInserted++;
        }
        await wait(2000);
        console.log(
          `[updateSlotGames]: size of ${games.length} ${provider?.provider_name} games inserted`,
        );
      }

      return { msg: `all games updated. Total: ${totalInserted}` };
    } catch (ex: any) {
      console.log('[getSlotGames] error occured: ', ex);
      return { msg: 'error occured' };
    }
  }

  async checkSlotGameUser(user_id: string) {
    try {
      const apiEndpoint = `${this.slotInfo.apiUrl}/v4/user/create`;
      const { data } = await firstValueFrom(
        this.httpService.post(
          apiEndpoint,
          { name: user_id?.replaceAll('@', '_').replaceAll('.', '_') },
          getSlotConfig(this.slotInfo.apiToken),
        ),
      );
      return data;
    } catch (ex:any) {
      this.logger.error(
        `[checkSlotGameUser] error: ${ex?.response?.data ? JSON.stringify(ex.response.data) : (ex?.message ?? String(ex))}`,
      );
      return null;
    }
  }

  async consumeSlotGameCallback(
    command: string,
    data: SlotGameCallbackDataDTO,
    _timestamp: string,
    check: string,
    callbackToken: string,
  ) {
    if (this.slotInfo.callbackToken !== callbackToken) {
      return {
        result: 100,
        status: 'error',
      };
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      let user: any = null;
      let transaction: any = null;

      const checkNumbers = check.split(',');
      for (const checkNumber of checkNumbers) {
        switch (Number(checkNumber)) {
          case 21: {
            const user_id = data.account;
            const replacedUser = user_id.replace('_', '@').replace('_', '.');
            const userRows = await qr.query(
              `SELECT id, username, email, vip_level, account_status FROM users WHERE username = $1 OR email = $1 OR username = $2 OR email = $2 LIMIT 1`,
              [user_id, replacedUser],
            );
            if (!userRows.length) {
              await qr.rollbackTransaction();
              await qr.release();
              return {
                result: checkNumber,
                status: 'ERROR',
              };
            }
            user = userRows[0];
            break;
          }
          case 22:
            if (!user || user.account_status !== 'ACTIVE') {
              await qr.rollbackTransaction();
              await qr.release();
              return {
                result: checkNumber,
                status: 'ERROR',
              };
            }
            break;
          case 31: {
            const amount = Number(data.amount);
            const walletRows = await qr.query(
              `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
              [user.id],
            );
            if (!walletRows.length || Number(walletRows[0].balance) < amount) {
              await qr.rollbackTransaction();
              await qr.release();
              return {
                result: checkNumber,
                status: 'ERROR',
                data: {
                  balance: walletRows.length
                    ? Number(walletRows[0].balance)
                    : 0,
                },
              };
            }
            break;
          }
          case 41: {
            transaction = await qr.query(
              `SELECT * FROM casino_game_logs WHERE transaction_id = $1 LIMIT 1`,
              [data.trans_guid],
            );
            if (transaction.length > 0) {
              const walletRes = await qr.query(
                `SELECT balance FROM wallets WHERE user_id = $1`,
                [user.id],
              );
              await qr.rollbackTransaction();
              await qr.release();
              return {
                result: checkNumber,
                status: 'ERROR',
                data: {
                  balance: Number(walletRes[0]?.balance ?? 0),
                },
              };
            }
            break;
          }
          case 42: {
            transaction = await qr.query(
              `SELECT * FROM casino_game_logs WHERE transaction_id = $1 LIMIT 1`,
              [data.trans_guid],
            );
            if (!transaction.length) {
              const walletRes = await qr.query(
                `SELECT balance FROM wallets WHERE user_id = $1`,
                [user.id],
              );
              await qr.rollbackTransaction();
              await qr.release();
              return {
                result: checkNumber,
                status: 'ERROR',
                data: {
                  balance: Number(walletRes[0]?.balance ?? 0),
                },
              };
            }
            transaction = transaction[0];
            break;
          }
        }
      }

      let result: any = null;
      switch (command) {
        case 'authenticate': {
          const walletRes = await qr.query(
            `SELECT balance FROM wallets WHERE user_id = $1`,
            [user.id],
          );
          await qr.commitTransaction();
          await qr.release();
          return {
            result: 0,
            status: 'OK',
            data: {
              account: user.username,
              balance: Number(walletRes[0]?.balance ?? 0),
            },
          };
        }
        case 'balance': {
          const walletRes = await qr.query(
            `SELECT balance FROM wallets WHERE user_id = $1`,
            [user.id],
          );
          await qr.commitTransaction();
          await qr.release();
          return {
            result: 0,
            status: 'OK',
            data: {
              balance: Number(walletRes[0]?.balance ?? 0),
            },
          };
        }
        case 'bet': {
          const amount = Number(data.amount);
          const wallet = await qr.query(
            `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
            [user.id],
          );
          const currentBalance = Number(wallet[0].balance);
          const newBalance = currentBalance - amount;
          await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
            newBalance,
            user.id,
          ]);

          const games = await qr.query(
            `SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`,
            [data.game_code],
          );
          const game = games[0];

          const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
          const userData = {
            user_id: user.id,
            username: user.username,
            vip_level: user.vip_level,
          };

          await qr.query(
            `INSERT INTO casino_game_logs 
               (user_id, user_name, game_uuid, game_name, game_provider, game_type, action, type, amount, tx_id, transaction_id, round_id, user_data)
             VALUES ($1, $2, $3, $4, $5, $6, 'bet', 'bet', $7, $8, $9, $10, $11)`,
            [
              user.id,
              user.username,
              game?.uuid ?? 'Unknown',
              game?.name ?? 'Unknown',
              game?.provider ?? 'Unknown',
              game?.type ?? 'Unknown',
              amount,
              tx_id,
              data.trans_guid,
              data.round_id,
              JSON.stringify(userData),
            ],
          );

          await qr.query(
            `INSERT INTO user_cash_logs 
               (user_id, user_data, amount, before_balance, after_balance, t_type, type)
             VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoBet')`,
            [
              user.id,
              JSON.stringify(userData),
              amount,
              currentBalance,
              newBalance,
            ],
          );

          await this.handleAffiliateCommission(
            qr,
            user.id,
            user.username,
            amount,
            'bet',
            'CASINO',
          );

          await qr.commitTransaction();
          await qr.release();

          this.walletGateway
            .pushBalanceUpdate(user.id)
            .catch((e) =>
              this.logger.warn(
                `WS push failed (bet) userId=${user.id}: ${e.message}`,
              ),
            );

          result = {
            result: 0,
            status: 'OK',
            data: {
              balance: newBalance,
            },
          };
          break;
        }
        case 'win': {
          const amount = Number(data.amount);
          const wallet = await qr.query(
            `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
            [user.id],
          );
          const currentBalance = Number(wallet[0].balance);
          const newBalance = currentBalance + amount;
          await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
            newBalance,
            user.id,
          ]);

          const games = await qr.query(
            `SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`,
            [data.game_code],
          );
          const game = games[0];

          const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
          const userData = {
            user_id: user.id,
            username: user.username,
            vip_level: user.vip_level,
          };

          await qr.query(
            `INSERT INTO casino_game_logs 
               (user_id, user_name, game_uuid, game_name, game_provider, game_type, action, type, amount, tx_id, transaction_id, round_id, user_data)
             VALUES ($1, $2, $3, $4, $5, $6, 'win', 'win', $7, $8, $9, $10, $11)`,
            [
              user.id,
              user.username,
              game?.uuid ?? 'Unknown',
              game?.name ?? 'Unknown',
              game?.provider ?? 'Unknown',
              game?.type ?? 'Unknown',
              amount,
              tx_id,
              data.trans_guid,
              data.round_id,
              JSON.stringify(userData),
            ],
          );

          await qr.query(
            `INSERT INTO user_cash_logs 
               (user_id, user_data, amount, before_balance, after_balance, t_type, type)
             VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoWin')`,
            [
              user.id,
              JSON.stringify(userData),
              amount,
              currentBalance,
              newBalance,
            ],
          );

          await this.handleAffiliateCommission(
            qr,
            user.id,
            user.username,
            amount,
            'win',
            'CASINO',
          );

          await qr.commitTransaction();
          await qr.release();

          this.walletGateway
            .pushBalanceUpdate(user.id)
            .catch((e) =>
              this.logger.warn(
                `WS push failed (win) userId=${user.id}: ${e.message}`,
              ),
            );

          result = {
            result: 0,
            status: 'OK',
            data: {
              balance: newBalance,
            },
          };
          break;
        }
        case 'cancel': {
          if (
            transaction.type !== 'cancel' &&
            transaction.action !== 'cancel'
          ) {
            const amount = Number(data.amount);
            const wallet = await qr.query(
              `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
              [user.id],
            );
            const currentBalance = Number(wallet[0].balance);

            let newBalance = currentBalance;
            if (transaction.type === 'bet' || transaction.action === 'bet') {
              newBalance = currentBalance + Number(transaction.amount);
            } else if (
              transaction.type === 'win' ||
              transaction.action === 'win'
            ) {
              newBalance = currentBalance - Number(transaction.amount);
            }

            await qr.query(
              `UPDATE wallets SET balance = $1 WHERE user_id = $2`,
              [newBalance, user.id],
            );

            const games = await qr.query(
              `SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`,
              [data.game_code],
            );
            const game = games[0];

            const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
            const userData = {
              user_id: user.id,
              username: user.username,
              vip_level: user.vip_level,
            };

            await qr.query(
              `INSERT INTO casino_game_logs 
                 (user_id, user_name, game_uuid, game_name, game_provider, game_type, action, type, amount, tx_id, transaction_id, round_id, rollback, user_data)
               VALUES ($1, $2, $3, $4, $5, $6, 'cancel', 'cancel', $7, $8, $9, $10, $11, $12)`,
              [
                user.id,
                user.username,
                game?.uuid ?? 'Unknown',
                game?.name ?? 'Unknown',
                game?.provider ?? 'Unknown',
                game?.type ?? 'Unknown',
                amount,
                tx_id,
                data.trans_guid,
                data.round_id,
                data.trans_guid,
                JSON.stringify(userData),
              ],
            );

            await qr.query(
              `INSERT INTO user_cash_logs 
                 (user_id, user_data, amount, before_balance, after_balance, t_type, type)
               VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoRefund')`,
              [
                user.id,
                JSON.stringify(userData),
                amount,
                currentBalance,
                newBalance,
              ],
            );

            await this.handleAffiliateCommission(
              qr,
              user.id,
              user.username,
              amount,
              'refund',
              'CASINO',
            );

            await qr.commitTransaction();
            await qr.release();

            this.walletGateway
              .pushBalanceUpdate(user.id)
              .catch((e) =>
                this.logger.warn(
                  `WS push failed (cancel) userId=${user.id}: ${e.message}`,
                ),
              );

            result = {
              result: 0,
              status: 'OK',
              data: {
                balance: newBalance,
              },
            };
          } else {
            const walletRes = await qr.query(
              `SELECT balance FROM wallets WHERE user_id = $1`,
              [user.id],
            );
            await qr.commitTransaction();
            await qr.release();
            result = {
              result: 0,
              status: 'OK',
              data: {
                balance: Number(walletRes[0]?.balance ?? 0),
              },
            };
          }
          break;
        }
        case 'status': {
          await qr.commitTransaction();
          await qr.release();
          result = {
            result: 0,
            status: 'OK',
            data: {
              account: user.username,
              trans_id: data.trans_guid,
              trans_status: transaction?.type === 'cancel' ? 'CANCELED' : 'OK',
            },
          };
          break;
        }
      }
      return result;
    } catch (ex: any) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error(
        `[consumeSlotGameCallback] error: ${ex?.message ?? String(ex)}`,
      );
      return {
        result: 99,
        status: 'ERROR',
      };
    }
  }

  /** Mask a secret for logs: show only head/tail + length, never the raw value. */
  private maskSecret(s?: string): string {
    if (!s) return '<empty>';
    if (s.length <= 6) return `***(len:${s.length})`;
    return `${s.slice(0, 3)}…${s.slice(-2)}(len:${s.length})`;
  }

  /** JSON.stringify that never throws (circular refs / BigInt) — for log payloads. */
  private safeJson(v: any): string {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  async consumeSportsCallback(
    command: string,
    data: SportsCallbackDataDTO,
    _key: string,
    callbackToken: string,
  ) {
    // Provider payloads use "userName" in some callbacks and "username" in others
    const userName = data.userName ?? data.username ?? '';
    // Short correlation id so every log line for ONE callback can be grep'd
    // together — e.g. `grep 'SportsCallback#1a2b3c4d'`.
    const reqId = createUUid().slice(0, 8);
    const recvToken = this.maskSecret(callbackToken);

    this.logger.log(
      `[SportsCallback#${reqId}] ===== START ===== command=${command} userName="${userName}" ` +
        `amount=${data.amount} type=${data.type} trans_id=${data.trans_id} ` +
        `trans_hist_id=${data.trans_hist_id} betCount=${data.betList?.length ?? 0} token=${recvToken}`,
    );
    // Full raw payload so a failed/odd callback can be replayed & inspected later.
    this.logger.log(`[SportsCallback#${reqId}] payload=${this.safeJson(data)}`);

    // Record receipt BEFORE any validation — proves the provider reached us at
    // all (the #1 thing to confirm when bets fail). Outcome code is filled in
    // below as we resolve the request.
    this.lastSportsCallback = {
      at: new Date().toISOString(),
      reqId,
      command,
      userName,
      code: null,
      note: 'received',
    };

    if (this.spotsInfo.callbackToken !== callbackToken) {
      this.logger.warn(
        `[SportsCallback#${reqId}] REJECTED 1001 invalid callback token: ` +
          `received=${recvToken} expected=${this.maskSecret(this.spotsInfo.callbackToken)}`,
      );
      this.lastSportsCallback.code = 1001;
      this.lastSportsCallback.note = 'invalid callback token';
      return {
        code: 1001,
        message: 'Failed',
        data: { name: '', balance: 0 },
      };
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // Usernames are sanitized (@ and . -> _) before being sent to the
      // provider, so match both the sanitized and original forms.
      const desanitized = userName.replace('_', '@').replace('_', '.');
      const userRows = await qr.query(
        `SELECT id, username, account_status FROM users WHERE username = $1 OR username = $2 LIMIT 1`,
        [userName, desanitized],
      );
      if (!userRows.length) {
        this.logger.warn(
          `[SportsCallback#${reqId}] REJECTED 1002 user not found: userName="${userName}" desanitized="${desanitized}"`,
        );
        await qr.rollbackTransaction();
        await qr.release();
        return {
          code: 1002,
          message: 'ERROR',
          data: { name: '', balance: 0 },
        };
      }
      const user = userRows[0];
      this.logger.log(
        `[SportsCallback#${reqId}] user resolved: id=${user.id} username="${user.username}" status=${user.account_status}`,
      );

      if (user.account_status !== 'ACTIVE') {
        this.logger.warn(
          `[SportsCallback#${reqId}] REJECTED 1001 account not active: userId=${user.id} status=${user.account_status}`,
        );
        await qr.rollbackTransaction();
        await qr.release();
        return {
          code: 1001,
          message: 'ERROR',
          data: { name: user.username, balance: 0 },
        };
      }

      const walletRows = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [user.id],
      );
      const currentBalance = Number(walletRows[0]?.balance ?? 0);
      this.logger.log(
        `[SportsCallback#${reqId}] wallet locked: userId=${user.id} balance=${currentBalance}` +
          (walletRows.length ? '' : ' (NO WALLET ROW — defaulted to 0)'),
      );

      if (command === 'bet' && currentBalance < Number(data.amount)) {
        this.logger.warn(
          `[SportsCallback#${reqId}] REJECTED 1001 insufficient balance: user=${user.username} balance=${currentBalance} required=${data.amount}`,
        );
        await qr.rollbackTransaction();
        await qr.release();
        return {
          code: 1001,
          message: 'ERROR',
          data: { name: user.username, balance: currentBalance },
        };
      }

      let result: any = null;
      switch (command) {
        case 'getBalance':
          this.logger.log(
            `[SportsCallback#${reqId}] getBalance -> balance=${currentBalance}`,
          );
          result = {
            code: 0,
            message: 'success',
            data: { name: user.username, balance: currentBalance },
          };
          break;

        case 'bet': {
          const totalStake = Number(data.amount);

          // Idempotency: each bet item id is unique per the provider spec.
          // If any is already recorded, this is a retry — don't deduct again.
          const betIds = (data.betList ?? [])
            .map((b) => b.id)
            .filter((id): id is string => !!id);
          if (betIds.length > 0) {
            const dup = await qr.query(
              `SELECT 1 FROM sports_bet_logs WHERE trans_id = ANY($1) LIMIT 1`,
              [betIds],
            );
            if (dup.length > 0) {
              this.logger.warn(
                `[SportsCallback#${reqId}] DUPLICATE bet (idempotent OK, no re-debit): ids=${betIds.join(',')}`,
              );
              result = {
                code: 0,
                message: 'OK',
                data: { name: user.username, balance: currentBalance },
              };
              break;
            }
          }

          const newBalance = currentBalance - totalStake;
          this.logger.log(
            `[SportsCallback#${reqId}] BET debit: stake=${totalStake} balance ${currentBalance} -> ${newBalance} slips=${data.betList?.length ?? 0}`,
          );

          await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
            newBalance,
            user.id,
          ]);

          // The live provider's bet payload omits per-slip stake fields — each
          // betList item is just { id, selections } and the stake is the
          // top-level data.amount. Prefer any slip-level stake if present,
          // otherwise split the total evenly across slips (single-slip bets →
          // the full amount). `amount` is NOT NULL, so never insert undefined.
          const slipCount = (data.betList ?? []).length || 1;
          for (const betData of data.betList ?? []) {
            const rawStake =
              betData.totalStake ??
              betData.finalStake ??
              betData.unitStake ??
              totalStake / slipCount;
            const slipStake = Number.isFinite(Number(rawStake))
              ? Number(rawStake)
              : 0;

            const betLog = await qr.query(
              `INSERT INTO sports_bet_logs (user_id, user_name, bet_list, trans_id, trans_hist_id, amount, type, date_time)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING id`,
              [
                user.id,
                user.username,
                JSON.stringify(betData),
                // The win callback's trans_id references this bet item id
                betData.id ?? data.trans_id ?? null,
                // trans_hist_id is only assigned at settlement (win callback)
                null,
                slipStake,
                betData.status ?? data.type ?? 0,
                data.dateTime ?? new Date().toISOString(),
              ],
            );

            // 🎯 Turnover: each sports bet's stake counts toward active turnover
            //    requirements — stake counts whether the bet wins or loses, same
            //    rule as the in-house game and the Palace/OroPlay integrations.
            //    In this same transaction; skips silently if no active reqs.
            await this.turnoverService.contributeFromSettledBet(
              qr,
              user.id,
              Number(betLog[0].id),
              slipStake,
            );

            this.logger.log(
              `[SportsCallback#${reqId}] bet slip recorded: logId=${betLog[0].id} ` +
                `trans_id=${betData.id ?? data.trans_id} stake=${slipStake} status=${betData.status ?? data.type ?? 0}`,
            );
          }

          const userData = { user_id: user.id, username: user.username };
          await qr.query(
            `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
             VALUES ($1, $2, $3, $4, $5, 'Sports', 'SportsBet')`,
            [
              user.id,
              JSON.stringify(userData),
              totalStake,
              currentBalance,
              newBalance,
            ],
          );

          await this.handleAffiliateCommission(
            qr,
            user.id,
            user.username,
            totalStake,
            'bet',
            'SPORTS',
          );

          result = {
            code: 0,
            message: 'OK',
            data: { name: user.username, balance: newBalance },
          };
          break;
        }

        case 'win': {
          const winAmount = Number(data.amount);

          // Idempotency: trans_hist_id is the provider's unique settlement id.
          // It's only written at settlement, so a hit means this is a retry.
          if (data.trans_hist_id) {
            const dup = await qr.query(
              `SELECT 1 FROM sports_bet_logs WHERE trans_hist_id = $1 LIMIT 1`,
              [data.trans_hist_id],
            );
            if (dup.length > 0) {
              this.logger.warn(
                `[SportsCallback#${reqId}] DUPLICATE win (idempotent OK, no re-credit): trans_hist_id=${data.trans_hist_id}`,
              );
              result = {
                code: 0,
                message: 'OK',
                data: { name: user.username, balance: currentBalance },
              };
              break;
            }
          }

          const newBalance = currentBalance + winAmount;

          await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
            newBalance,
            user.id,
          ]);

          // Outcome (win/lose/cashout/refund) arrives in betList[0].status
          const settledStatus = data.betList?.[0]?.status ?? data.type ?? 1;
          this.logger.log(
            `[SportsCallback#${reqId}] WIN credit: payout=${winAmount} balance ${currentBalance} -> ${newBalance} ` +
              `settledStatus=${settledStatus} trans_id=${data.trans_id} trans_hist_id=${data.trans_hist_id}`,
          );

          const betLogs = await qr.query(
            `SELECT * FROM sports_bet_logs WHERE trans_id = $1 LIMIT 1`,
            [data.trans_id],
          );
          if (betLogs.length > 0) {
            const betLog = betLogs[0];
            const updatedBetList = {
              ...betLog.bet_list,
              status: settledStatus,
            };
            if (data.betList && data.betList.length > 0) {
              updatedBetList.selections = data.betList[0].selections;
            }
            await qr.query(
              `UPDATE sports_bet_logs
                  SET bet_list = $1, type = $2, trans_hist_id = $3,
                      win_amount = $4, settled_at = NOW()
                WHERE id = $5`,
              [
                JSON.stringify(updatedBetList),
                settledStatus,
                data.trans_hist_id ?? null,
                // Realized payout credited at settlement (0 for a losing slip);
                // lets game-history report exact won/lost instead of guessing.
                winAmount,
                betLog.id,
              ],
            );
            this.logger.log(
              `[SportsCallback#${reqId}] settled existing slip: logId=${betLog.id} win_amount=${winAmount} status=${settledStatus}`,
            );
          } else {
            // No matching bet log — record the settlement anyway so a
            // provider retry is still caught by the trans_hist_id check.
            this.logger.warn(
              `[SportsCallback#${reqId}] WIN: no bet slip for trans_id=${data.trans_id} — inserting settlement-only row (bet callback may have been missed)`,
            );
            await qr.query(
              `INSERT INTO sports_bet_logs
                 (user_id, user_name, bet_list, trans_id, trans_hist_id, amount, type, date_time, win_amount, settled_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
              [
                user.id,
                user.username,
                JSON.stringify(data.betList?.[0] ?? {}),
                data.trans_id ?? null,
                data.trans_hist_id ?? null,
                winAmount,
                settledStatus,
                data.dateTime ?? new Date().toISOString(),
                winAmount,
              ],
            );
          }

          const userData = { user_id: user.id, username: user.username };
          await qr.query(
            `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
             VALUES ($1, $2, $3, $4, $5, 'Sports', 'SportsWin')`,
            [
              user.id,
              JSON.stringify(userData),
              winAmount,
              currentBalance,
              newBalance,
            ],
          );

          await this.handleAffiliateCommission(
            qr,
            user.id,
            user.username,
            winAmount,
            'win',
            'SPORTS',
          );

          result = {
            code: 0,
            message: 'OK',
            data: { name: user.username, balance: newBalance },
          };
          break;
        }

        default:
          this.logger.warn(
            `[SportsCallback#${reqId}] UNKNOWN command="${command}" -> 9999`,
          );
          result = {
            code: 9999,
            message: 'Failed',
            data: { name: user.username, balance: currentBalance },
          };
          break;
      }

      await qr.commitTransaction();
      await qr.release();

      if (['bet', 'win'].includes(command)) {
        this.walletGateway
          .pushBalanceUpdate(user.id)
          .catch((e) =>
            this.logger.warn(
              `[SportsCallback#${reqId}] WS push failed for user ${user.id}: ${e.message}`,
            ),
          );
      }

      if (this.lastSportsCallback) {
        this.lastSportsCallback.code = result?.code ?? null;
        this.lastSportsCallback.note = result?.message ?? 'ok';
      }

      this.logger.log(
        `[SportsCallback#${reqId}] ===== END ===== command=${command} code=${result?.code} response=${this.safeJson(result)}`,
      );
      return result;
    } catch (ex: any) {
      await qr.rollbackTransaction();
      await qr.release();
      if (this.lastSportsCallback) {
        this.lastSportsCallback.code = 9999;
        this.lastSportsCallback.note = ex?.message ?? 'exception';
      }
      // This is what surfaces to the provider as a failed callback (and can be
      // what makes their placeWidget call 500). Full context for a post-mortem.
      this.logger.error(
        `[SportsCallback#${reqId}] CRITICAL ERROR -> 9999: ${ex?.message} | ` +
          `command=${command} userName="${userName}" payload=${this.safeJson(data)}`,
        ex?.stack,
      );
      return {
        code: 9999,
        message: 'ERROR',
        data: { name: userName, balance: 0 },
      };
    }
  }

  async consumeMiniGameCallback_GetBalance(reqData: GetMiniBalanceDTO) {
    console.log('GetBalance');
    const wallet = await this.dataSource.query(
      `SELECT balance FROM wallets WHERE user_id = $1`,
      [Number(reqData.userId)],
    );
    return {
      status: 'ok',
      data: {
        balance: Number(wallet[0]?.balance ?? 0),
      },
    };
  }

  async consumeMiniGameCallback_BetWin(reqData: MiniBetWinDTO) {
    console.log('BetWin');
    const userId = Number(reqData.userId);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const userRows = await qr.query(
        `SELECT id, username, vip_level FROM users WHERE id = $1 LIMIT 1`,
        [userId],
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, msg: 'User not found' };
      }
      const user = userRows[0];

      const walletRows = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const beforeBalance = Number(walletRows[0].balance);
      const afterBalance =
        beforeBalance - reqData.betAmount + reqData.winAmount;

      await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
        afterBalance,
        userId,
      ]);

      const games = await qr.query(
        `SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`,
        [reqData.gameCode],
      );
      const game = games[0];

      const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
      const transaction_id = `${reqData.transactionId}_${Date.now()}`;
      const transaction_id_win = `${reqData.transactionId}1_${Date.now()}`;

      const userData = {
        user_id: user.id,
        username: user.username,
        vip_level: user.vip_level,
      };

      await qr.query(
        `INSERT INTO casino_game_logs 
           (user_id, user_name, game_uuid, game_name, game_provider, game_type, action, type, amount, tx_id, transaction_id, round_id, user_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'bet', 'bet', $7, $8, $9, $10, $11)`,
        [
          user.id,
          user.username,
          game?.uuid ?? 'Unknown',
          game?.name ?? 'Unknown',
          game?.provider ?? 'Unknown',
          game?.type ?? 'Unknown',
          reqData.betAmount,
          tx_id,
          transaction_id,
          transaction_id,
          JSON.stringify(userData),
        ],
      );

      await qr.query(
        `INSERT INTO casino_game_logs 
           (user_id, user_name, game_uuid, game_name, game_provider, game_type, action, type, amount, tx_id, transaction_id, round_id, user_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'win', 'win', $7, $8, $9, $10, $11)`,
        [
          user.id,
          user.username,
          game?.uuid ?? 'Unknown',
          game?.name ?? 'Unknown',
          game?.provider ?? 'Unknown',
          game?.type ?? 'Unknown',
          reqData.winAmount,
          tx_id,
          transaction_id_win,
          transaction_id,
          JSON.stringify(userData),
        ],
      );

      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoBet')`,
        [
          user.id,
          JSON.stringify(userData),
          reqData.betAmount,
          beforeBalance,
          beforeBalance - reqData.betAmount,
        ],
      );

      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoWin')`,
        [
          user.id,
          JSON.stringify(userData),
          reqData.winAmount,
          beforeBalance - reqData.betAmount,
          afterBalance,
        ],
      );

      await this.handleAffiliateCommission(
        qr,
        user.id,
        user.username,
        reqData.betAmount,
        'bet',
        'MINI_GAME',
      );
      await this.handleAffiliateCommission(
        qr,
        user.id,
        user.username,
        reqData.winAmount,
        'win',
        'MINI_GAME',
      );

      await qr.commitTransaction();
      await qr.release();

      this.walletGateway
        .pushBalanceUpdate(user.id)
        .catch((e) =>
          this.logger.warn(
            `WS push failed (mini betwin) userId=${user.id}: ${e.message}`,
          ),
        );

      return {
        status: 'ok',
        data: { balance: afterBalance },
      };
    } catch (err: any) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error(
        `Mini betwin transaction save error: ${err?.message ?? String(err)}`,
      );
      return { success: false, msg: 'Transaction save error' };
    }
  }

  async consumeMiniGameCallback_Withdraw(reqData: MiniWithdrawDTO) {
    console.log('Withdraw');
    const userId = Number(reqData.userId);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const userRows = await qr.query(
        `SELECT id, username, vip_level FROM users WHERE id = $1 LIMIT 1`,
        [userId],
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, msg: 'User not found' };
      }
      const user = userRows[0];

      const walletRows = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const beforeBalance = Number(walletRows[0].balance);
      const afterBalance = beforeBalance - reqData.amount;

      await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
        afterBalance,
        userId,
      ]);

      const games = await qr.query(
        `SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`,
        [reqData.gameCode],
      );
      const game = games[0];

      const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
      const transaction_id = `${reqData.transactionId}_${Date.now()}`;
      const userData = {
        user_id: user.id,
        username: user.username,
        vip_level: user.vip_level,
      };

      await qr.query(
        `INSERT INTO casino_game_logs 
           (user_id, user_name, game_uuid, game_name, game_provider, game_type, action, type, amount, tx_id, transaction_id, round_id, user_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'bet', 'bet', $7, $8, $9, $10, $11)`,
        [
          user.id,
          user.username,
          game?.uuid ?? 'Unknown',
          game?.name ?? 'Unknown',
          game?.provider ?? 'Unknown',
          game?.type ?? 'Unknown',
          reqData.amount,
          tx_id,
          transaction_id,
          transaction_id,
          JSON.stringify(userData),
        ],
      );

      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoBet')`,
        [
          user.id,
          JSON.stringify(userData),
          reqData.amount,
          beforeBalance,
          afterBalance,
        ],
      );

      await this.handleAffiliateCommission(
        qr,
        user.id,
        user.username,
        reqData.amount,
        'bet',
        'MINI_GAME',
      );

      await qr.commitTransaction();
      await qr.release();

      this.walletGateway
        .pushBalanceUpdate(user.id)
        .catch((e) =>
          this.logger.warn(
            `WS push failed (mini withdraw) userId=${user.id}: ${e.message}`,
          ),
        );

      return {
        status: 'ok',
        data: { balance: afterBalance },
      };
    } catch (err: any) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error(
        `Mini withdraw transaction save error: ${err?.message ?? String(err)}`,
      );
      return { success: false, msg: 'Transaction save error' };
    }
  }

  async consumeMiniGameCallback_Deposit(reqData: MiniDepositDTO) {
    console.log('Deposit');
    const userId = Number(reqData.userId);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const userRows = await qr.query(
        `SELECT id, username, vip_level FROM users WHERE id = $1 LIMIT 1`,
        [userId],
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, msg: 'User not found' };
      }
      const user = userRows[0];

      const walletRows = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const beforeBalance = Number(walletRows[0].balance);
      const afterBalance = beforeBalance + reqData.amount;

      await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [
        afterBalance,
        userId,
      ]);

      const games = await qr.query(
        `SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`,
        [reqData.gameCode],
      );
      const game = games[0];

      const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
      const transaction_id = `${reqData.transactionId}_${Date.now()}`;
      const userData = {
        user_id: user.id,
        username: user.username,
        vip_level: user.vip_level,
      };

      await qr.query(
        `INSERT INTO casino_game_logs 
           (user_id, user_name, game_uuid, game_name, game_provider, game_type, action, type, amount, tx_id, transaction_id, round_id, user_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'win', 'win', $7, $8, $9, $10, $11)`,
        [
          user.id,
          user.username,
          game?.uuid ?? 'Unknown',
          game?.name ?? 'Unknown',
          game?.provider ?? 'Unknown',
          game?.type ?? 'Unknown',
          reqData.amount,
          tx_id,
          transaction_id,
          transaction_id,
          JSON.stringify(userData),
        ],
      );

      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoWin')`,
        [
          user.id,
          JSON.stringify(userData),
          reqData.amount,
          beforeBalance,
          afterBalance,
        ],
      );

      await this.handleAffiliateCommission(
        qr,
        user.id,
        user.username,
        reqData.amount,
        'win',
        'MINI_GAME',
      );

      await qr.commitTransaction();
      await qr.release();

      this.walletGateway
        .pushBalanceUpdate(user.id)
        .catch((e) =>
          this.logger.warn(
            `WS push failed (mini deposit) userId=${user.id}: ${e.message}`,
          ),
        );

      return {
        status: 'ok',
        data: { balance: afterBalance },
      };
    } catch (err: any) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error(
        `Mini deposit transaction save error: ${err?.message ?? String(err)}`,
      );
      return { success: false, msg: 'Transaction save error' };
    }
  }

  private async handleAffiliateCommission(
    qr: QueryRunner,
    userId: number,
    _username: string,
    amount: number,
    action: string,
    source: string,
  ) {
    try {
      const referral = await qr.query(
        `SELECT referrer_user_id FROM referrals WHERE referee_user_id = $1 LIMIT 1`,
        [userId],
      );
      if (!referral.length) return;
      const referrerId = Number(referral[0].referrer_user_id);

      const affiliate = await qr.query(
        `SELECT commission_pct, is_active FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
        [referrerId],
      );
      if (!affiliate.length || !affiliate[0].is_active) return;
      const commissionPct = Number(affiliate[0].commission_pct);

      let profit = 0;
      if (action === 'bet' || action === 'Bet') {
        profit = (amount * commissionPct) / 100;
      } else {
        profit = -((amount * commissionPct) / 100);
      }

      if (profit !== 0) {
        await qr.query(
          `INSERT INTO referral_bonus (referrer_user_id, referee_user_id, amount, source, status, created_at, approved_at)
           VALUES ($1, $2, $3, $4, 'APPROVED', NOW(), NOW())`,
          [referrerId, userId, profit, source],
        );
        await qr.query(
          `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2`,
          [profit, referrerId],
        );

        this.walletGateway
          .pushBalanceUpdate(referrerId)
          .catch((e) =>
            this.logger.warn(
              `WS push failed for referrer id=${referrerId}: ${e.message}`,
            ),
          );

        const referrerUser = await qr.query(
          `SELECT username FROM users WHERE id = $1`,
          [referrerId],
        );
        const refereeUser = await qr.query(
          `SELECT username, vip_level FROM users WHERE id = $1`,
          [userId],
        );
        const referrerWallet = await qr.query(
          `SELECT balance FROM wallets WHERE user_id = $1`,
          [referrerId],
        );

        const partner_username = referrerUser[0]?.username || '';
        const referee_username = refereeUser[0]?.username || '';
        const referee_level = refereeUser[0]?.vip_level
          ? String(refereeUser[0].vip_level)
          : '0';
        const before_balance = Number(referrerWallet[0]?.balance ?? 0) - profit;
        const after_balance = Number(referrerWallet[0]?.balance ?? 0);

        await qr.query(
          `INSERT INTO partner_profit_logs
             (partner_user_id, partner_nickname, user_id, user_nickname, user_level, amount, before_balance, after_balance, type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            String(referrerId),
            partner_username,
            userId,
            referee_username,
            referee_level,
            profit,
            before_balance,
            after_balance,
            source + '_' + action.toUpperCase(),
          ],
        );
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to handle affiliate commission: ${err.message}`,
      );
    }
  }
}

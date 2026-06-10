import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { DataSource, QueryRunner } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import * as querystring from 'querystring';
import axios from 'axios';
import { v4 as createUUid } from 'uuid';
import { WalletGateway } from '../wallet/wallet.gateway';
import { GetMiniBalanceDTO, MiniBetWinDTO, MiniDepositDTO, MiniWithdrawDTO } from './dto/minicallback.dto';
import { SlotGameCallbackDataDTO } from './dto/slotgamecallback.dto';
import { SportsCallbackDataDTO } from './dto/sportscallback.dto';

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
  method = 'get'
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
      'Content-Type': method === 'post' ? 'application/x-www-form-urlencoded' : 'application/json',
    },
  };
}

@Injectable()
export class CasinoService {
  private readonly logger = new Logger(CasinoService.name);
  private readonly casinoInfo: { apiUrl: string; merchantID: string; merchantKey: string; callbackToken: string };
  private readonly slotInfo: { apiUrl: string; apiToken: string; callbackToken: string };
  private readonly spotsInfo: { apiUrl: string; apiToken: string; callbackToken: string };
  private readonly oroplayInfo: { apiUrl: string; clientId: string; clientSecret: string };
  private readonly miniInfo: { endpoint: string; apiToken: string; callbackToken: string };
  private readonly nounce = 'e115cf0f66a645aca08225c9c1b20b81';

  // OroPlay token cache
  private oroplayToken = '';
  private oroplayTokenExpiration = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly dataSource: DataSource,
    private readonly walletGateway: WalletGateway,
  ) {
    this.casinoInfo = {
      apiUrl: this.configService.get<string>('CASINO_API_URL') ?? 'https://api.slotegrator.com',
      merchantID: this.configService.get<string>('CASINO_MERCHANT_ID') ?? '',
      merchantKey: this.configService.get<string>('CASINO_MERCHANT_KEY') ?? '',
      callbackToken: this.configService.get<string>('CASINO_CALLBACK_TOKEN') ?? '',
    };
    this.slotInfo = {
      apiUrl: this.configService.get<string>('SLOT_API_ENDPOINT') ?? 'https://agent.goldslotpalase.com',
      apiToken: this.configService.get<string>('SLOT_API_TOKEN') ?? '',
      callbackToken: this.configService.get<string>('SLOT_CALLBACK_TOKEN') ?? '',
    };
    this.spotsInfo = {
      apiUrl: this.configService.get<string>('SPORTS_API_URL') ?? 'https://sportsbook.needforspeedau.com',
      apiToken: this.configService.get<string>('SPORTS_API_TOKEN') ?? '',
      callbackToken: this.configService.get<string>('SPORTS_CALLBACK_TOKEN') ?? '',
    };
    this.oroplayInfo = {
      apiUrl: this.configService.get<string>('OROPLAY_API_ENDPOINT') ?? 'https://bs.sxvwlkohlv.com/api/v2',
      clientId: this.configService.get<string>('OROPLAY_CLIENT_ID') ?? 'Dark_BDT',
      clientSecret: this.configService.get<string>('OROPLAY_CLIENT_SECRET') ?? '',
    };
    this.miniInfo = {
      endpoint: this.configService.get<string>('MINI_API_URL') ?? 'https://miniback.betjoyful.com/api',
      apiToken: this.configService.get<string>('MINI_API_TOKEN') ?? '',
      callbackToken: this.configService.get<string>('MINI_CALLBACK_TOKEN') ?? '',
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
      this.logger.error(`casinoInitDemo ::: ${error?.response?.data?.message ?? error.message}`);
      return null;
    }
  }

  async getCasinoGames(query: any, userPayload: any, isMobile: string) {
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
      conditions.push(`((name NOT ILIKE '%Mobile%' AND is_mobile = 0) OR (name NOT ILIKE '%Mobile%' AND is_mobile = 1))`);
    }

    // RTP filter
    if (query?.filters?.is_rtp) {
      conditions.push(`parameters IS NOT NULL AND (parameters->>'rtp') IS NOT NULL`);
    }

    // Search filter
    if (query?.search) {
      conditions.push(`name ILIKE $${paramIndex++}`);
      values.push(`%${query.search}%`);
    }

    // Type filter
    if (query?.filters?.type) {
      if (query.filters.type === 'live') {
        conditions.push(`type NOT IN ('slots', 'instant') AND vendor_code IS NOT NULL`);
      } else {
        conditions.push(`type = $${paramIndex++}`);
        values.push(query.filters.type);
      }
    }

    // New filter
    if (query?.filters?.is_new !== undefined) {
      conditions.push(`is_new = $${paramIndex++}`);
      values.push(query.filters.is_new === 'true' || query.filters.is_new === true);
    }

    // Providers filter
    if (query?.filters?.providers && Array.isArray(query.filters.providers) && query.filters.providers.length > 0) {
      conditions.push(`provider = ANY($${paramIndex++})`);
      values.push(query.filters.providers);
    }

    // Has tables filter
    if (query?.filters?.has_tables !== undefined) {
      conditions.push(`has_tables = $${paramIndex++}`);
      values.push(Number(query.filters.has_tables));
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countQuery = `SELECT COUNT(*)::int AS total FROM casino_games ${whereClause}`;
    const dataQuery = `SELECT * FROM casino_games ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;

    const countResult = await this.dataSource.query(countQuery, values);
    const dataResult = await this.dataSource.query(dataQuery, [...values, size, offset]);

    return {
      items: dataResult,
      total: countResult[0]?.total ?? 0,
    };
  }

  async getLiveVendors() {
    const rows = await this.dataSource.query(
      `SELECT DISTINCT provider FROM casino_games 
       WHERE vendor_code IS NOT NULL AND type NOT IN ('slots', 'instant') 
       ORDER BY provider ASC`
    );
    return rows.map((r: any) => r.provider);
  }

  async getSportsLink(query: any, userPayload: any, isMobile: string, language?: string): Promise<string | null> {
    try {
      const SPORTS_SUPPORTED_LANGS = ['en', 'fr', 'fa', 'ar', 'tr'];
      const sportsLang = SPORTS_SUPPORTED_LANGS.includes(language ?? '') ? language : 'en';
      let userCode = '';
      let resUrl = 'https://sportsbook.needforspeedau.com';

      if (userPayload !== undefined) {
        const userId = userPayload.sub;
        const userRows = await this.dataSource.query(`SELECT username FROM users WHERE id = $1`, [userId]);
        if (!userRows.length) return null;
        userCode = userRows[0].username;

        const userCreateRes = await axios.post<any>(
          `${this.spotsInfo.apiUrl}/v1/user/create`,
          { name: userCode },
          {
            headers: {
              Authorization: `Bearer ${this.spotsInfo.apiToken}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (userCreateRes.data.code !== 0) {
          this.logger.error(`User creation failed: ${userCreateRes.data.message}`);
          return null;
        }

        const gameUrlRes = await axios.post<any>(
          `${this.spotsInfo.apiUrl}/v1/game/game-url`,
          { userCode, language: sportsLang },
          {
            headers: {
              Authorization: `Bearer ${this.spotsInfo.apiToken}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (gameUrlRes.data.code !== 0) {
          this.logger.error(`Failed to get game URL: ${gameUrlRes.data.message}`);
          return null;
        }

        resUrl = gameUrlRes.data.data.gameUrl;
      }
      return resUrl;
    } catch (error) {
      this.logger.error('Error in getSportsLink:', error);
      return null;
    }
  }

  async getAuthGames(query: any, userPayload: any, isMobile: string) {
    const userId = userPayload.sub;
    const userRows = await this.dataSource.query(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRows.length) return { items: [], total: 0 };
    const user = userRows[0];

    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (isMobile === 'true') {
      conditions.push(`is_mobile = 1`);
    } else {
      conditions.push(`((name NOT ILIKE '%Mobile%' AND is_mobile = 0) OR (name NOT ILIKE '%Mobile%' AND is_mobile = 1))`);
    }

    if (query?.search) {
      conditions.push(`name ILIKE $${paramIndex++}`);
      values.push(`%${query.search}%`);
    }

    if (query?.filters?.providers && Array.isArray(query.filters.providers) && query.filters.providers.length > 0) {
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

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const items = await this.dataSource.query(`SELECT * FROM casino_games ${whereClause}`, values);
    const total = await this.dataSource.query(`SELECT COUNT(*)::int AS total FROM casino_games ${whereClause}`, values);

    return {
      items,
      total: total[0]?.total ?? 0,
    };
  }

  async getGameUrl(uuid: string, query: any, userPayload: any, isMobile: string) {
    this.logger.log(`[getGameUrl] START - uuid: ${uuid}, user: ${userPayload?.sub}, isMobile: ${isMobile}, searchType: ${query?.searchType}`);
    
    const games = await this.dataSource.query(`SELECT * FROM casino_games WHERE uuid = $1 LIMIT 1`, [uuid]);
    if (!games.length) {
      throw new HttpException('Game not found', HttpStatus.NOT_FOUND);
    }
    const game = games[0];

    this.logger.log(`[getGameUrl] game found: true, name: ${game?.name}, type: ${game?.type}, provider: ${game?.provider}, provider_id: ${game?.provider_id}, game_symbol: ${game?.game_symbol}`);

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
    const userRows = await this.dataSource.query(`SELECT username, email FROM users WHERE id = $1`, [userId]);
    if (!userRows.length) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }
    const user = userRows[0];

    if (query?.searchType === 'real') {
      if (game.type === 'slots' || game.provider === 'Spribe' || game.provider === 'Tydo') {
        this.logger.log(`[getGameUrl] SLOT/Spribe/Tydo path - checking slot user: ${user.username}`);
        const checkSlotGameUser = await this.checkSlotGameUser(user.username);
        this.logger.log(`[getGameUrl] checkSlotGameUser result: ${JSON.stringify(checkSlotGameUser)}`);
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
          this.logger.log(`[getGameUrl] SLOT API request - endpoint: ${apiEndpoint}, body: ${JSON.stringify(requestBody)}`);
          const { data } = await firstValueFrom(
            this.httpService.post(
              apiEndpoint,
              requestBody,
              getSlotConfig(this.slotInfo.apiToken),
            ),
          );
          this.logger.log(`[getGameUrl] SLOT API response: ${JSON.stringify(data)}`);
          return { url: data?.data?.game_url };
        } catch (ex: any) {
          this.logger.error(`[getGameUrl] SLOT API error: ${ex?.message}, response: ${JSON.stringify(ex?.response?.data)}`);
          return null;
        }
      }
      else if (game.type === 'instant' && game.provider !== 'Spribe') {
        this.logger.log(`[getGameUrl] INSTANT path - gameCode: ${game.game_symbol}, userId: ${userId}`);
        const response = await axios.post(
          `${this.miniInfo.endpoint}/gameurl`,
          {
            gameCode: game.game_symbol,
            userId: String(userId),
            userName: user.username,
            lang: 'en',
            lobbyurl: process.env.LOBBY_URL || 'https://lobby.slotcity.com',
          },
          {
            headers: {
              Authorization: `Bearer ${this.miniInfo.apiToken}`,
            },
            proxy: false,
          },
        );
        this.logger.log(`[getGameUrl] INSTANT response url: ${response.data?.data?.url}`);
        return { url: response.data?.data?.url };
      }
      else {
        // OroPlay Live Casino
        try {
          this.logger.log(`[getGameUrl] LIVE (OroPlay) path - uuid: ${uuid}, user: ${user.username}`);
          const launchUrl = await this.getOroPlayLaunchUrl(
            game.vendor_code,
            game.game_code,
            user.username,
            'en',
          );
          this.logger.log(`[getGameUrl] LIVE (OroPlay) launch URL received`);
          return { url: launchUrl };
        } catch (error: any) {
          this.logger.error(`[getGameUrl] LIVE (OroPlay) error - game: ${uuid}, message: ${error?.message}`);
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
      [...values, size, offset]
    );

    const countResult = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM casino_game_logs ${whereClause}`,
      values
    );

    return {
      items,
      total: countResult[0]?.total ?? 0,
    };
  }

  async updateLiveCasinoGames() {
    try {
      this.logger.log('[OroPlay] Starting live casino games sync...');
      const liveVendors = await this.getOroPlayLiveVendors();
      this.logger.log(`[OroPlay] Found ${liveVendors.length} live casino vendors`);

      await this.dataSource.query(`DELETE FROM casino_games WHERE type NOT IN ('slots', 'instant')`);

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
            else if (nameLower.includes('poker') || nameLower.includes('holdem')) type = 'table';

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
                JSON.stringify({ rtp: 95, volatility: null, reels_count: null, lines_count: null }),
                '[]',
                '[]',
                '[]',
                game.isNew || false,
              ]
            );
            totalInserted++;
          }
          await wait(500);
        } catch (vendorError: any) {
          this.logger.error(`[OroPlay] Error fetching games for ${vendor.vendorCode}: ${vendorError?.message}`);
        }
      }

      this.logger.log(`[OroPlay] Live casino sync complete. Total: ${totalInserted} games`);
      return { msg: `all games updated. Total: ${totalInserted} games from ${liveVendors.length} vendors` };
    } catch (ex: any) {
      this.logger.error(`[OroPlay] updateLiveCasinoGames error: ${ex?.message}`);
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
    const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf-8');
    const [clientId, clientSecret] = decoded.split(':');
    return clientId === this.oroplayInfo.clientId && clientSecret === this.oroplayInfo.clientSecret;
  }

  async getOroPlayLiveVendors(): Promise<any[]> {
    const token = await this.getOroPlayToken();
    const response = await axios.get(
      `${this.oroplayInfo.apiUrl}/vendors/list`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.data.success) {
      throw new Error(`OroPlay vendors/list failed: errorCode=${response.data.errorCode}`);
    }
    return response.data.message.filter((v: any) => v.type === 1);
  }

  async getOroPlayGamesList(vendorCode: string, language = 'en'): Promise<any[]> {
    const token = await this.getOroPlayToken();
    const response = await axios.post(
      `${this.oroplayInfo.apiUrl}/games/list`,
      { vendorCode, language },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.data.success) {
      throw new Error(`OroPlay games/list failed for ${vendorCode}: errorCode=${response.data.errorCode}`);
    }
    return response.data.message;
  }

  async getOroPlayLaunchUrl(vendorCode: string, gameCode: string, userCode: string, language = 'en'): Promise<string> {
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
      throw new Error(`OroPlay launch-url failed: errorCode=${response.data.errorCode}`);
    }
    return response.data.message;
  }

  async handleOroPlayBalance(userCode: string) {
    const rows = await this.dataSource.query(
      `SELECT u.id, w.balance FROM users u 
       JOIN wallets w ON w.user_id = u.id 
       WHERE u.username = $1 LIMIT 1`,
      [userCode]
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
    historyId: number,
    roundId: string,
    gameType: number,
    transactionCode: string,
    isFinished: boolean,
    isCanceled: boolean,
    amount: number,
    detail: string,
    createdAt: string,
  ) {
    this.logger.log(`[OroPlay TX] userCode=${userCode}, vendorCode=${vendorCode}, gameCode=${gameCode}, amount=${amount}, txCode=${transactionCode}, isCanceled=${isCanceled}`);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const existingTx = await qr.query(
        `SELECT id FROM casino_game_logs WHERE transaction_id = $1 LIMIT 1`,
        [transactionCode]
      );
      if (existingTx.length > 0) {
        this.logger.warn(`[OroPlay TX] Duplicate transaction: ${transactionCode}`);
        const userWallet = await qr.query(
          `SELECT w.balance FROM users u 
           JOIN wallets w ON w.user_id = u.id 
           WHERE u.username = $1 LIMIT 1`,
          [userCode]
        );
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, message: Number(userWallet[0]?.balance ?? 0), errorCode: 6 }; // DUPLICATE_TRANSACTION
      }

      const userRows = await qr.query(
        `SELECT id, username, vip_level FROM users WHERE username = $1 LIMIT 1`,
        [userCode]
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, message: 0, errorCode: 2 }; // USER_DOES_NOT_EXIST
      }
      const user = userRows[0];

      const walletRows = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [user.id]
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

      await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBalance, user.id]);

      const gameRows = await qr.query(
        `SELECT uuid, name, provider, type FROM casino_games 
         WHERE (vendor_code = $1 AND game_code = $2) OR uuid = $3 LIMIT 1`,
        [vendorCode, gameCode, gameCode]
      );
      const game = gameRows[0];

      const isBet = amount < 0;
      const action = isCanceled ? 'cancel' : (isBet ? 'bet' : 'win');
      const absAmount = Math.abs(amount);

      const tx_id = `${user.username}_${game?.uuid ?? gameCode}_${Date.now()}`;
      const userData = { user_id: user.id, username: user.username, vip_level: user.vip_level };

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
         ]
      );

      const userCashLogType = isCanceled ? 'CasinoRefund' : (isBet ? 'CasinoBet' : 'CasinoWin');
      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', $6)`,
        [user.id, JSON.stringify(userData), absAmount, currentBalance, newBalance, userCashLogType]
      );

      await this.handleAffiliateCommission(qr, user.id, user.username, absAmount, action, 'CASINO');

      await qr.commitTransaction();
      await qr.release();

      this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
        this.logger.warn(`WS push failed (oroplay tx) userId=${user.id}: ${e.message}`),
      );

      this.logger.log(`[OroPlay TX] Success - userCode=${userCode}, newBalance=${newBalance}`);
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
      await this.dataSource.query(`DELETE FROM casino_games WHERE type = 'slots'`);

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
              JSON.stringify({ rtp: 95, volatility: 'high', reels_count: 5, lines_count: 20 }),
              '[]',
              '[]',
              '[]',
              false,
            ]
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
    } catch (ex) {
      this.logger.error('[checkSlotGameUser]: ', ex);
      return null;
    }
  }

  async consumeSlotGameCallback(
    command: string,
    data: SlotGameCallbackDataDTO,
    timestamp: string,
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
              [user_id, replacedUser]
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
              [user.id]
            );
            if (!walletRows.length || Number(walletRows[0].balance) < amount) {
              await qr.rollbackTransaction();
              await qr.release();
              return {
                result: checkNumber,
                status: 'ERROR',
                data: {
                  balance: walletRows.length ? Number(walletRows[0].balance) : 0,
                },
              };
            }
            break;
          }
          case 41: {
            transaction = await qr.query(
              `SELECT * FROM casino_game_logs WHERE transaction_id = $1 LIMIT 1`,
              [data.trans_guid]
            );
            if (transaction.length > 0) {
              const walletRes = await qr.query(`SELECT balance FROM wallets WHERE user_id = $1`, [user.id]);
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
              [data.trans_guid]
            );
            if (!transaction.length) {
              const walletRes = await qr.query(`SELECT balance FROM wallets WHERE user_id = $1`, [user.id]);
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
          const walletRes = await qr.query(`SELECT balance FROM wallets WHERE user_id = $1`, [user.id]);
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
          const walletRes = await qr.query(`SELECT balance FROM wallets WHERE user_id = $1`, [user.id]);
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
          const wallet = await qr.query(`SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`, [user.id]);
          const currentBalance = Number(wallet[0].balance);
          const newBalance = currentBalance - amount;
          await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBalance, user.id]);

          const games = await qr.query(`SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`, [data.game_code]);
          const game = games[0];
          
          const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
          const userData = { user_id: user.id, username: user.username, vip_level: user.vip_level };
          
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
            ]
          );

          await qr.query(
            `INSERT INTO user_cash_logs 
               (user_id, user_data, amount, before_balance, after_balance, t_type, type)
             VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoBet')`,
            [user.id, JSON.stringify(userData), amount, currentBalance, newBalance]
          );

          await this.handleAffiliateCommission(qr, user.id, user.username, amount, 'bet', 'CASINO');

          await qr.commitTransaction();
          await qr.release();

          this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
            this.logger.warn(`WS push failed (bet) userId=${user.id}: ${e.message}`),
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
          const wallet = await qr.query(`SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`, [user.id]);
          const currentBalance = Number(wallet[0].balance);
          const newBalance = currentBalance + amount;
          await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBalance, user.id]);

          const games = await qr.query(`SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`, [data.game_code]);
          const game = games[0];
          
          const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
          const userData = { user_id: user.id, username: user.username, vip_level: user.vip_level };
          
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
            ]
          );

          await qr.query(
            `INSERT INTO user_cash_logs 
               (user_id, user_data, amount, before_balance, after_balance, t_type, type)
             VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoWin')`,
            [user.id, JSON.stringify(userData), amount, currentBalance, newBalance]
          );

          await this.handleAffiliateCommission(qr, user.id, user.username, amount, 'win', 'CASINO');

          await qr.commitTransaction();
          await qr.release();

          this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
            this.logger.warn(`WS push failed (win) userId=${user.id}: ${e.message}`),
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
          if (transaction.type !== 'cancel' && transaction.action !== 'cancel') {
            const amount = Number(data.amount);
            const wallet = await qr.query(`SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`, [user.id]);
            const currentBalance = Number(wallet[0].balance);
            
            let newBalance = currentBalance;
            if (transaction.type === 'bet' || transaction.action === 'bet') {
              newBalance = currentBalance + Number(transaction.amount);
            } else if (transaction.type === 'win' || transaction.action === 'win') {
              newBalance = currentBalance - Number(transaction.amount);
            }

            await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBalance, user.id]);

            const games = await qr.query(`SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`, [data.game_code]);
            const game = games[0];
            
            const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
            const userData = { user_id: user.id, username: user.username, vip_level: user.vip_level };
            
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
              ]
            );

            await qr.query(
              `INSERT INTO user_cash_logs 
                 (user_id, user_data, amount, before_balance, after_balance, t_type, type)
               VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoRefund')`,
              [user.id, JSON.stringify(userData), amount, currentBalance, newBalance]
            );

            await this.handleAffiliateCommission(qr, user.id, user.username, amount, 'refund', 'CASINO');

            await qr.commitTransaction();
            await qr.release();

            this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
              this.logger.warn(`WS push failed (cancel) userId=${user.id}: ${e.message}`),
            );

            result = {
              result: 0,
              status: 'OK',
              data: {
                balance: newBalance,
              },
            };
          } else {
            const walletRes = await qr.query(`SELECT balance FROM wallets WHERE user_id = $1`, [user.id]);
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
    } catch (ex) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error('[consumeSlotGameCallback] error: ', ex);
      return {
        result: 99,
        status: 'ERROR',
      };
    }
  }

  async consumeSportsCallback(
    command: string,
    data: SportsCallbackDataDTO,
    key: string,
    callbackToken: string,
  ) {
    this.logger.log(`[SportsCallback] ========== START ==========`);
    this.logger.log(`[SportsCallback] command=${command}, userName=${data.userName}, amount=${data.amount}, type=${data.type}, trans_id=${data.trans_id}`);
    
    if (this.spotsInfo.callbackToken !== callbackToken) {
      this.logger.warn(`[SportsCallback] Invalid callback token. Expected=${this.spotsInfo.callbackToken}, Got=${callbackToken}`);
      return {
        result: 100,
        status: 'error',
      };
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const userRows = await qr.query(
        `SELECT id, username, account_status FROM users WHERE username = $1 LIMIT 1`,
        [data.userName]
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return {
          code: 1002,
          message: 'ERROR',
          data: { name: '', balance: 0 },
        };
      }
      const user = userRows[0];

      if (user.account_status !== 'ACTIVE') {
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
        [user.id]
      );
      const currentBalance = Number(walletRows[0]?.balance ?? 0);

      if (command === 'bet' && currentBalance < Number(data.amount)) {
        this.logger.warn(`[SportsCallback] Insufficient balance: user=${user.username}, balance=${currentBalance}, required=${data.amount}`);
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
          result = {
            code: 0,
            message: 'success',
            data: { name: user.username, balance: currentBalance },
          };
          break;

        case 'bet': {
          const totalStake = Number(data.amount);
          const newBalance = currentBalance - totalStake;

          await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBalance, user.id]);

          for (const betData of data.betList) {
            await qr.query(
              `INSERT INTO sports_bet_logs (user_name, bet_list, trans_id, trans_hist_id, amount, type, date_time)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                data.userName,
                JSON.stringify(betData),
                data.trans_id,
                data.trans_hist_id,
                betData.totalStake,
                data.type,
                data.dateTime,
              ]
            );
          }

          const userData = { user_id: user.id, username: user.username };
          await qr.query(
            `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
             VALUES ($1, $2, $3, $4, $5, 'Sports', 'SportsBet')`,
            [user.id, JSON.stringify(userData), totalStake, currentBalance, newBalance]
          );

          await this.handleAffiliateCommission(qr, user.id, user.username, totalStake, 'bet', 'SPORTS');

          result = {
            code: 0,
            message: 'OK',
            data: { name: user.username, balance: newBalance },
          };
          break;
        }

        case 'win': {
          const winAmount = Number(data.amount);
          const newBalance = currentBalance + winAmount;

          await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBalance, user.id]);

          const betLogs = await qr.query(
            `SELECT * FROM sports_bet_logs WHERE trans_id = $1 LIMIT 1`,
            [data.trans_id]
          );
          if (betLogs.length > 0) {
            const betLog = betLogs[0];
            const updatedBetList = { ...betLog.bet_list, status: data.type };
            if (data.betList && data.betList.length > 0) {
              updatedBetList.selections = data.betList[0].selections;
            }
            await qr.query(
              `UPDATE sports_bet_logs SET bet_list = $1, type = $2 WHERE id = $3`,
              [JSON.stringify(updatedBetList), data.type, betLog.id]
            );
          } else {
            this.logger.warn(`[SportsCallback] WIN: BetLog NOT FOUND for trans_id=${data.trans_id}`);
          }

          const userData = { user_id: user.id, username: user.username };
          await qr.query(
            `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
             VALUES ($1, $2, $3, $4, $5, 'Sports', 'SportsWin')`,
            [user.id, JSON.stringify(userData), winAmount, currentBalance, newBalance]
          );

          await this.handleAffiliateCommission(qr, user.id, user.username, winAmount, 'win', 'SPORTS');

          result = {
            code: 0,
            message: 'OK',
            data: { name: user.username, balance: newBalance },
          };
          break;
        }
      }

      await qr.commitTransaction();
      await qr.release();

      if (['bet', 'win'].includes(command)) {
        this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
          this.logger.warn(`WS push failed for user ${user.id}: ${e.message}`),
        );
      }

      this.logger.log(`[SportsCallback] ========== END: command=${command}, result code=${result?.code} ==========`);
      return result;

    } catch (ex: any) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error(`[SportsCallback] CRITICAL ERROR: ${ex?.message}`, ex?.stack);
      return {
        code: 99,
        message: 'ERROR',
        data: { name: data.userName, balance: 0 },
      };
    }
  }

  async consumeMiniGameCallback_GetBalance(reqData: GetMiniBalanceDTO) {
    console.log('GetBalance');
    const wallet = await this.dataSource.query(
      `SELECT balance FROM wallets WHERE user_id = $1`,
      [Number(reqData.userId)]
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
        [userId]
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, msg: 'User not found' };
      }
      const user = userRows[0];

      const walletRows = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const beforeBalance = Number(walletRows[0].balance);
      const afterBalance = beforeBalance - reqData.betAmount + reqData.winAmount;

      await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [afterBalance, userId]);

      const games = await qr.query(
        `SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`,
        [reqData.gameCode]
      );
      const game = games[0];

      const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
      const transaction_id = `${reqData.transactionId}_${Date.now()}`;
      const transaction_id_win = `${reqData.transactionId}1_${Date.now()}`;
      
      const userData = { user_id: user.id, username: user.username, vip_level: user.vip_level };

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
        ]
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
        ]
      );

      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoBet')`,
        [user.id, JSON.stringify(userData), reqData.betAmount, beforeBalance, beforeBalance - reqData.betAmount]
      );

      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoWin')`,
        [user.id, JSON.stringify(userData), reqData.winAmount, beforeBalance - reqData.betAmount, afterBalance]
      );

      await this.handleAffiliateCommission(qr, user.id, user.username, reqData.betAmount, 'bet', 'MINI_GAME');
      await this.handleAffiliateCommission(qr, user.id, user.username, reqData.winAmount, 'win', 'MINI_GAME');

      await qr.commitTransaction();
      await qr.release();

      this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
        this.logger.warn(`WS push failed (mini betwin) userId=${user.id}: ${e.message}`),
      );

      return {
        status: 'ok',
        data: { balance: afterBalance },
      };
    } catch (err: any) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error('Mini betwin transaction save error', err);
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
        [userId]
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, msg: 'User not found' };
      }
      const user = userRows[0];

      const walletRows = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const beforeBalance = Number(walletRows[0].balance);
      const afterBalance = beforeBalance - reqData.amount;

      await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [afterBalance, userId]);

      const games = await qr.query(
        `SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`,
        [reqData.gameCode]
      );
      const game = games[0];

      const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
      const transaction_id = `${reqData.transactionId}_${Date.now()}`;
      const userData = { user_id: user.id, username: user.username, vip_level: user.vip_level };

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
        ]
      );

      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoBet')`,
        [user.id, JSON.stringify(userData), reqData.amount, beforeBalance, afterBalance]
      );

      await this.handleAffiliateCommission(qr, user.id, user.username, reqData.amount, 'bet', 'MINI_GAME');

      await qr.commitTransaction();
      await qr.release();

      this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
        this.logger.warn(`WS push failed (mini withdraw) userId=${user.id}: ${e.message}`),
      );

      return {
        status: 'ok',
        data: { balance: afterBalance },
      };
    } catch (err: any) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error('Mini withdraw transaction save error', err);
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
        [userId]
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        await qr.release();
        return { success: false, msg: 'User not found' };
      }
      const user = userRows[0];

      const walletRows = await qr.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const beforeBalance = Number(walletRows[0].balance);
      const afterBalance = beforeBalance + reqData.amount;

      await qr.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [afterBalance, userId]);

      const games = await qr.query(
        `SELECT uuid, name, provider, type FROM casino_games WHERE game_symbol = $1 LIMIT 1`,
        [reqData.gameCode]
      );
      const game = games[0];

      const tx_id = `${user.username}_${game?.uuid ?? 'Unknown'}_${Date.now()}`;
      const transaction_id = `${reqData.transactionId}_${Date.now()}`;
      const userData = { user_id: user.id, username: user.username, vip_level: user.vip_level };

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
        ]
      );

      await qr.query(
        `INSERT INTO user_cash_logs (user_id, user_data, amount, before_balance, after_balance, t_type, type)
         VALUES ($1, $2, $3, $4, $5, 'Casino', 'CasinoWin')`,
        [user.id, JSON.stringify(userData), reqData.amount, beforeBalance, afterBalance]
      );

      await this.handleAffiliateCommission(qr, user.id, user.username, reqData.amount, 'win', 'MINI_GAME');

      await qr.commitTransaction();
      await qr.release();

      this.walletGateway.pushBalanceUpdate(user.id).catch((e) =>
        this.logger.warn(`WS push failed (mini deposit) userId=${user.id}: ${e.message}`),
      );

      return {
        status: 'ok',
        data: { balance: afterBalance },
      };
    } catch (err: any) {
      await qr.rollbackTransaction();
      await qr.release();
      this.logger.error('Mini deposit transaction save error', err);
      return { success: false, msg: 'Transaction save error' };
    }
  }

  private async handleAffiliateCommission(
    qr: QueryRunner,
    userId: number,
    username: string,
    amount: number,
    action: string,
    source: string
  ) {
    try {
      const referral = await qr.query(
        `SELECT referrer_user_id FROM referrals WHERE referee_user_id = $1 LIMIT 1`,
        [userId]
      );
      if (!referral.length) return;
      const referrerId = Number(referral[0].referrer_user_id);

      const affiliate = await qr.query(
        `SELECT commission_pct, is_active FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
        [referrerId]
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
          [referrerId, userId, profit, source]
        );
        await qr.query(
          `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2`,
          [profit, referrerId]
        );

        this.walletGateway.pushBalanceUpdate(referrerId).catch((e) =>
          this.logger.warn(`WS push failed for referrer id=${referrerId}: ${e.message}`),
        );

        const referrerUser = await qr.query(`SELECT username FROM users WHERE id = $1`, [referrerId]);
        const refereeUser = await qr.query(`SELECT username, vip_level FROM users WHERE id = $1`, [userId]);
        const referrerWallet = await qr.query(`SELECT balance FROM wallets WHERE user_id = $1`, [referrerId]);
        
        const partner_username = referrerUser[0]?.username || '';
        const referee_username = refereeUser[0]?.username || '';
        const referee_level = refereeUser[0]?.vip_level ? String(refereeUser[0].vip_level) : '0';
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
            source + '_' + action.toUpperCase()
          ]
        );
      }
    } catch (err: any) {
      this.logger.error(`Failed to handle affiliate commission: ${err.message}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * Outbound client for the Nexus GGR game API.
 *
 * Every call is a POST of a flat JSON body to a single endpoint, dispatched on
 * `method`, authenticated with agent_code + agent_token. (Note the asymmetry:
 * outbound uses the TOKEN, while the inbound /gold_api callbacks carry the
 * SECRET. They are different values and swapping them fails with "Invalid
 * Agent".)
 *
 * Follows the WinyPay client's contract — explicit timeout, and failures are
 * RETURNED as a result object rather than thrown, so a provider outage surfaces
 * as a handled empty catalog rather than a 500 on an admin screen.
 *
 * NOTE: Nexus enforces an IP allowlist. Calls from anywhere but a registered
 * server address come back as `INVALID_IP` regardless of credentials.
 */

export type NexusResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** Shapes confirmed against the live API, not just the docs. */
export interface NexusProvider {
  code: string;
  name: string;
  /** slot | live | SB | MN | FH — the authority for categorising its games. */
  type: string;
  status: number;
}

/**
 * Note there is NO type field here: game_list returns only these keys, so a
 * game's category has to come from its provider.
 */
export interface NexusGame {
  id?: number;
  game_code: string;
  game_name: string;
  banner?: string;
  status?: number;
}

@Injectable()
export class NexusClient {
  private readonly logger = new Logger(NexusClient.name);

  constructor(private readonly config: ConfigService) {}

  private endpoint(): string {
    return (
      this.config.get<string>('NEXUS_API_ENDPOINT') ?? 'https://api.nexusggr.com'
    ).replace(/\/+$/, '');
  }
  private agentCode(): string {
    return this.config.get<string>('NEXUS_AGENT_CODE') ?? '';
  }
  private agentToken(): string {
    return this.config.get<string>('NEXUS_AGENT_TOKEN') ?? '';
  }

  get configured(): boolean {
    return !!this.agentCode() && !!this.agentToken();
  }

  /** One POST, one shape. `method` selects the operation. */
  private async post(method: string, extra: Record<string, unknown> = {}): Promise<any> {
    if (!this.configured) {
      throw new Error('NEXUS_AGENT_CODE / NEXUS_AGENT_TOKEN not configured');
    }
    const body = {
      method,
      agent_code: this.agentCode(),
      agent_token: this.agentToken(),
      ...extra,
    };
    const { data } = await axios.post(this.endpoint(), body, {
      timeout: 20000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Force IPv4. Nexus authorises callers by IP, and the address registered
      // in their panel is the server's IPv4 one. Node prefers IPv6 when the
      // host has it, which egresses from a DIFFERENT address and comes back as
      // INVALID_IP — intermittently, since IPv6 privacy extensions rotate the
      // suffix. Verified against the live API: identical request, IPv4 → 200
      // SUCCESS, IPv6 → INVALID_IP.
      family: 4,
    });
    return data;
  }

  /**
   * Nexus reports failure two different ways — `status: 0` with `msg`, and an
   * IP-allowlist rejection with `code`/`message`. Normalise both.
   */
  private failure(data: any): string | null {
    const status = String(data?.status ?? '');
    if (status === '1') return null;
    return data?.msg ?? data?.message ?? data?.code ?? `unexpected response (status=${status})`;
  }

  async providerList(): Promise<NexusResult<{ providers: NexusProvider[] }>> {
    try {
      const data = await this.post('provider_list');
      const err = this.failure(data);
      if (err) {
        this.logger.error(`[Nexus] provider_list failed: ${err}`);
        return { ok: false, error: err };
      }
      return { ok: true, providers: data.providers ?? [] };
    } catch (e: any) {
      const msg = e?.response?.data ? JSON.stringify(e.response.data) : e?.message;
      this.logger.error(`[Nexus] provider_list error: ${msg}`);
      return { ok: false, error: String(msg).slice(0, 300) };
    }
  }

  async gameList(providerCode: string): Promise<NexusResult<{ games: NexusGame[] }>> {
    try {
      const data = await this.post('game_list', { provider_code: providerCode });
      const err = this.failure(data);
      if (err) {
        this.logger.error(`[Nexus] game_list(${providerCode}) failed: ${err}`);
        return { ok: false, error: err };
      }
      return { ok: true, games: data.games ?? [] };
    } catch (e: any) {
      const msg = e?.response?.data ? JSON.stringify(e.response.data) : e?.message;
      this.logger.error(`[Nexus] game_list(${providerCode}) error: ${msg}`);
      return { ok: false, error: String(msg).slice(0, 300) };
    }
  }

  /**
   * `user_code` is the identity Nexus will send back on every /gold_api
   * callback, so it must be the player's `username` — the same value the
   * callback resolves against. Anything else silently breaks the wallet link.
   *
   * `game_code` may be omitted for live providers to get a lobby URL.
   */
  async gameLaunch(req: {
    userCode: string;
    providerCode: string;
    gameCode?: string;
    lang?: string;
    lobbyUrl?: string;
  }): Promise<NexusResult<{ launchUrl: string }>> {
    try {
      const extra: Record<string, unknown> = {
        user_code: req.userCode,
        provider_code: req.providerCode,
        lang: req.lang ?? 'en',
      };
      if (req.gameCode) extra.game_code = req.gameCode;
      if (req.lobbyUrl) extra.lobby_url = req.lobbyUrl;

      const data = await this.post('game_launch', extra);
      const err = this.failure(data);
      if (err) {
        this.logger.error(
          `[Nexus] game_launch failed user=${req.userCode} ` +
            `provider=${req.providerCode} game=${req.gameCode ?? '(lobby)'}: ${err}`,
        );
        return { ok: false, error: err };
      }
      return { ok: true, launchUrl: data.launch_url };
    } catch (e: any) {
      const msg = e?.response?.data ? JSON.stringify(e.response.data) : e?.message;
      this.logger.error(`[Nexus] game_launch error: ${msg}`);
      return { ok: false, error: String(msg).slice(0, 300) };
    }
  }
}

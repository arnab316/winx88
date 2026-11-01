import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * OroPlay token cache.
 *
 * `POST /auth/createtoken` is HARD rate-limited — the live account answers
 * "API calls quota exceeded! maximum admitted 1 per 10s" with a 429 — and
 * OroPlay's docs warn that hammering it can get the account blocked. So this
 * cache is not an optimisation, it is the only thing keeping the integration
 * alive, and it has to survive an upstream that does not answer exactly as
 * documented.
 *
 * Two failures put it over quota in production:
 *
 *   1. `expiration` was trusted as an absolute unix-seconds timestamp and
 *      assigned raw. Anything else — the field missing, or a RELATIVE ttl
 *      like 3600 ("in an hour", the usual `expires_in` convention) — made
 *      `now < expiresAt - 60` false forever, so every single call refetched.
 *      Missing is the worse of the two: it compares against NaN, which is
 *      false with no value in the log to explain it.
 *
 *   2. A failed refresh was retried immediately by the next caller, so once
 *      the quota was breached it stayed breached.
 *
 * Both are handled below: the expiry is interpreted defensively and a failure
 * starts a cooldown, during which a still-valid cached token keeps being
 * served rather than throwing.
 */
@Injectable()
export class OroplayTokenCache {
  private readonly logger = new Logger(OroplayTokenCache.name);
  private cachedToken: string | null = null;
  private expiresAt = 0; // unix seconds
  private inFlight: Promise<string> | null = null;

  /** Earliest unix second at which another createtoken may be attempted. */
  private retryAfter = 0;
  /** The failure that opened the cooldown, rethrown while it lasts. */
  private lastError: Error | null = null;

  /** Refresh this long before the token actually expires. */
  private static readonly REFRESH_MARGIN_S = 60;
  /** Used when the upstream gives us no usable expiry of its own. */
  private static readonly FALLBACK_TTL_S = 15 * 60;
  /** Never trust a TTL longer than this, however it was expressed. */
  private static readonly MAX_TTL_S = 24 * 60 * 60;
  /** How long to wait after a failed createtoken, absent a Retry-After. */
  private static readonly COOLDOWN_S = 10;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    if (this.cachedToken && now < this.expiresAt - OroplayTokenCache.REFRESH_MARGIN_S) {
      return this.cachedToken;
    }

    // Past the refresh margin but not past the real expiry, this token still
    // works. Held on to as the answer of last resort: a refresh that fails
    // must not take down callers who could have been served.
    const stale =
      this.cachedToken && now < this.expiresAt ? this.cachedToken : null;

    // A refresh already failed recently. Going again now would just be
    // refused and keep the quota pinned.
    if (now < this.retryAfter) {
      if (stale) return stale;
      throw this.lastError ?? new Error('OroPlay token unavailable');
    }

    // Deduplicate concurrent refreshes — the stampede this endpoint punishes.
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => {
        this.inFlight = null;
      });
    }

    try {
      return await this.inFlight;
    } catch (err) {
      if (stale) return stale;
      throw err;
    }
  }

  /**
   * Turn whatever `expiration` the upstream sent into an absolute unix-second
   * expiry, or null when it cannot be read.
   *
   * Accepts the three shapes an auth endpoint realistically returns: absolute
   * seconds, absolute milliseconds, and a relative lifetime. They are told
   * apart by magnitude, which is unambiguous for any plausible value — a
   * relative ttl is at most a day (86 400) while an absolute one is ~1.7e9.
   */
  private parseExpiry(raw: unknown, now: number): number | null {
    const n = typeof raw === 'string' ? Number(raw) : (raw as number);
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;

    // Absolute, in milliseconds.
    if (n > 1e12) return Math.floor(n / 1000);
    // Absolute, in seconds — must actually be in the future to mean anything.
    if (n > 1e9) return n > now ? Math.floor(n) : null;
    // Anything smaller is a lifetime, not a timestamp.
    if (n <= OroplayTokenCache.MAX_TTL_S) return now + Math.floor(n);
    return null;
  }

  private async fetchToken(): Promise<string> {
    const baseUrl = this.config.get<string>('OROPLAY_API_ENDPOINT');
    const clientId = this.config.get<string>('OROPLAY_CLIENT_ID');
    const clientSecret = this.config.get<string>('OROPLAY_CLIENT_SECRET');

    if (!baseUrl || !clientId || !clientSecret) {
      throw new Error(
        'OROPLAY_API_ENDPOINT / OROPLAY_CLIENT_ID / OROPLAY_CLIENT_SECRET must be set',
      );
    }

    try {
      const { data } = await firstValueFrom(
        this.http.post(
          `${baseUrl}/auth/createtoken`,
          { clientId, clientSecret },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10_000,
          },
        ),
      );

      if (!data?.token) {
        throw new Error(`OroPlay token creation failed: ${JSON.stringify(data)}`);
      }

      const now = Math.floor(Date.now() / 1000);
      const parsed = this.parseExpiry(data.expiration, now);

      this.cachedToken = data.token;
      this.expiresAt = parsed ?? now + OroplayTokenCache.FALLBACK_TTL_S;
      this.retryAfter = 0;
      this.lastError = null;

      if (parsed === null) {
        // Logged loudly and with the raw value: an unreadable expiry is what
        // silently disabled this cache, and the value itself is the only way
        // to tell which shape the upstream has switched to.
        this.logger.warn(
          `OroPlay token has no usable expiration (got ${JSON.stringify(data.expiration)}) — ` +
            `caching for ${OroplayTokenCache.FALLBACK_TTL_S}s instead`,
        );
      }

      this.logger.log(
        `OroPlay token refreshed, expires at ${new Date(this.expiresAt * 1000).toISOString()}`,
      );
      return this.cachedToken!;
    } catch (err: any) {
      // Open a cooldown so the next caller does not immediately re-breach the
      // quota. OroPlay sends Retry-After on its 429; honour it when present.
      const now = Math.floor(Date.now() / 1000);
      const header = Number(err?.response?.headers?.['retry-after']);
      const wait =
        Number.isFinite(header) && header > 0
          ? header
          : OroplayTokenCache.COOLDOWN_S;
      this.retryAfter = now + wait;
      this.lastError = err instanceof Error ? err : new Error(String(err));

      this.logger.error(
        `OroPlay createtoken failed (${err?.response?.status ?? 'no status'}): ` +
          `${err?.message} — not retrying for ${wait}s`,
      );
      throw this.lastError;
    }
  }

  invalidate() {
    this.cachedToken = null;
    this.expiresAt = 0;
  }
}

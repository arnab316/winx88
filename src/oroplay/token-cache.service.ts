import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * OroPlay token cache.
 *
 * OroPlay's POST /auth/createtoken is rate-limited to 5 requests per 30s,
 * and tokens come with an expiration timestamp. We cache the token in memory
 * and refresh 60s before expiry. Excessive token requests can result in
 * account blocking per OroPlay docs, so this caching is mandatory.
 */
@Injectable()
export class OroplayTokenCache {
  private readonly logger = new Logger(OroplayTokenCache.name);
  private cachedToken: string | null = null;
  private expiresAt = 0; // unix seconds
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    // Return cached token if still valid (with 60s safety buffer)
    if (this.cachedToken && now < this.expiresAt - 60) {
      return this.cachedToken;
    }

    // If a refresh is already in flight, await it instead of starting a second one
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchToken().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
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

    this.cachedToken = data.token;
    this.expiresAt = data.expiration;
    this.logger.log(
      `OroPlay token refreshed, expires at ${new Date(this.expiresAt * 1000).toISOString()}`,
    );
    return this.cachedToken!;
  }

  invalidate() {
    this.cachedToken = null;
    this.expiresAt = 0;
  }
}

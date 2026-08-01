import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limits the vendor reporting API per API KEY rather than per IP.
 *
 * A media buyer usually calls from a small pool of server IPs (or from behind a
 * NAT they share with others), so IP-based limiting would either throttle two
 * unrelated vendors together or fail to limit one that rotates egress
 * addresses. Keying on the vendor id resolved by ApiKeyGuard is exact.
 *
 * Must be listed AFTER ApiKeyGuard in @UseGuards so `req.vendor` is populated;
 * it falls back to IP if it ever runs unauthenticated.
 */
@Injectable()
export class VendorThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.vendor?.id ? `vendor:${req.vendor.id}` : `ip:${req.ip}`;
  }
}

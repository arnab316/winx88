import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';

/**
 * Scoped API-key auth for third-party marketing vendors (GET /partner/*).
 *
 * This is the only inbound auth in the codebase that is NOT a JWT — an external
 * agency must be able to pull their own numbers without ever holding an admin
 * token, which would grant them everything.
 *
 * Key format: `x-api-key: <prefix>.<secret>`
 *   prefix  public lookup handle, indexed, safe to log
 *   secret  shown once at issuance; only sha256(secret) is stored
 *
 * Sets `req.vendor = { id, name, keyId }`. The vendor id is then bound directly
 * into the report SQL, so scoping is enforced by the query rather than by
 * application logic that could be bypassed.
 *
 * Every failure raises the same UnauthorizedException with the same message:
 * distinguishing "unknown key" from "wrong secret" would turn this into an
 * oracle for probing which prefixes exist.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  // Compared against when the prefix is unknown, so a bad prefix costs the same
  // time as a bad secret and the lookup can't be timed to enumerate keys.
  private static readonly DUMMY_HASH = crypto
    .createHash('sha256')
    .update('invalid')
    .digest('hex');

  constructor(private readonly dataSource: DataSource) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header = req.headers['x-api-key'];
    const raw = (Array.isArray(header) ? header[0] : header ?? '').trim();

    const sep = raw.indexOf('.');
    const prefix = sep > 0 ? raw.slice(0, sep) : '';
    const secret = sep > 0 ? raw.slice(sep + 1) : '';

    let row: any = null;
    if (prefix && secret) {
      const rows = await this.dataSource.query(
        `SELECT k.id, k.key_hash, k.vendor_id, v.name AS vendor_name
           FROM marketing_vendor_api_keys k
           JOIN marketing_vendors v ON v.id = k.vendor_id
          WHERE k.key_prefix = $1
            AND k.status = 'ACTIVE'
            AND v.status = 'ACTIVE'
            AND (k.expires_at IS NULL OR k.expires_at > NOW())
          LIMIT 1`,
        [prefix],
      );
      row = rows[0] ?? null;
    }

    const expected = row?.key_hash ?? ApiKeyGuard.DUMMY_HASH;
    const actual = crypto.createHash('sha256').update(secret).digest('hex');
    // Both are fixed-length sha256 hex, so timingSafeEqual never throws on
    // length mismatch and no length information leaks.
    const ok =
      !!row &&
      crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));

    if (!ok) throw new UnauthorizedException('Invalid API key');

    req.vendor = {
      id: Number(row.vendor_id),
      name: row.vendor_name,
      keyId: Number(row.id),
    };

    // Usage stamp is diagnostic only — never let it fail or slow the request.
    this.dataSource
      .query(`UPDATE marketing_vendor_api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id])
      .catch(() => undefined);

    return true;
  }
}

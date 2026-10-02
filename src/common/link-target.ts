import { BadRequestException } from '@nestjs/common';

/**
 * Where an admin-configured tile sends the player. Shared by home shortcuts
 * and promo banners so the two can't drift apart.
 *
 *   CATEGORY — a game category key the panel understands ('slot',
 *              'Live Casino', 'Fishing', 'Crash', 'Poker')
 *   ROUTE    — an in-app path, must start with '/'
 *   EXTERNAL — an absolute off-site URL (social, campaign landing page)
 */
export type LinkTargetType = 'CATEGORY' | 'ROUTE' | 'EXTERNAL';

export const LINK_TARGET_TYPES: LinkTargetType[] = ['CATEGORY', 'ROUTE', 'EXTERNAL'];

/**
 * Validates a (type, value) pair before it is stored.
 *
 * EXTERNAL values are rendered into an anchor, so anything that isn't plain
 * http(s) — `javascript:`, `data:`, a bare path — is rejected outright.
 *
 * The scheme is checked with a regex BEFORE parsing: `new URL()` is not
 * consistently strict across runtimes (in the server a bare path like
 * '/promotion' parses instead of throwing), so testing the string first keeps
 * this deterministic regardless of which URL implementation is loaded.
 */
export function assertLinkTarget(type: LinkTargetType, value: string): void {
  if (!LINK_TARGET_TYPES.includes(type)) {
    throw new BadRequestException(
      `targetType must be one of ${LINK_TARGET_TYPES.join(', ')}`,
    );
  }

  const v = String(value ?? '').trim();
  if (!v) throw new BadRequestException('targetValue is required');

  if (type === 'EXTERNAL') {
    if (!/^https?:\/\//i.test(v)) {
      throw new BadRequestException(
        'EXTERNAL targetValue must be an absolute URL starting with http:// or https://, e.g. https://t.me/yourchannel',
      );
    }
    try {
      new URL(v);
    } catch {
      throw new BadRequestException('EXTERNAL targetValue is not a valid URL');
    }
  }

  if (type === 'ROUTE' && !v.startsWith('/')) {
    throw new BadRequestException('ROUTE targetValue must start with "/"');
  }
}

/**
 * TypeORM's `query()` returns `[rows, affectedCount]` for UPDATE/DELETE ...
 * RETURNING, but plain `rows` for INSERT ... RETURNING. Reading `result[0]`
 * without this yields the rows ARRAY rather than the first row, so every field
 * silently comes back `undefined` with a 200 and nothing throws.
 */
export function unwrapReturning(result: any): any[] {
  if (!Array.isArray(result)) return [];
  return Array.isArray(result[0]) ? result[0] : result;
}

// src/common/guards/active-account.guard.ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { assertUserActive } from '../account-status.util';

/**
 * Blocks any player route when the account is not ACTIVE
 * (INACTIVE / SUSPENDED / LOCKED / BLOCKED).
 *
 * ALWAYS use it AFTER JwtAuthGuard — it reads the user id that guard puts on
 * the request:  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
 *
 * Guards run in declaration order, so JwtAuthGuard has already populated
 * `req.user` by the time this one runs.
 *
 * This exists because access tokens are valid for 7 days: suspending an
 * account does not invalidate the token the player is already holding, so the
 * status has to be re-checked on every sensitive request, not just at login.
 */
@Injectable()
export class ActiveAccountGuard implements CanActivate {
  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId = Number(req.user?.sub ?? req.user?.id);
    await assertUserActive(this.dataSource, userId);
    return true;
  }
}

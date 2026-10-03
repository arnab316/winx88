import { Injectable, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Attaches `request.user` when a valid token is present, and lets the request
 * through untouched when it isn't.
 *
 * Used by public game listings, which anyone can browse but which should paint
 * the signed-in player's favourite hearts. `JwtAuthGuard` can't do this — it
 * throws 401 with no token — and the alternative (a second authenticated
 * endpoint, or a follow-up /me/favourites call per page) is worse.
 *
 * An invalid or expired token is treated exactly like no token: the page still
 * renders, just signed-out. It must never 401, or a stale token would break
 * browsing for a logged-out visitor.
 */
@Injectable()
export class OptionalJwtAuthGuard {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['authorization']?.split(' ')[1];
    if (!token) return true;

    try {
      request.user = this.jwtService.verify(token);
    } catch {
      // Deliberately ignored — browse on as an anonymous visitor.
    }
    return true;
  }
}

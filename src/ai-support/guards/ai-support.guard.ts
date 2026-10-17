import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Who may call /internal/ai-support/*, and as whom.
 *
 * Two independent checks, both required:
 *
 *  1. The CALLER is the support service — a shared secret in
 *     `x-ai-support-key`, compared against AI_SUPPORT_API_KEY. This stops the
 *     endpoints being reachable from a browser with a stolen player token.
 *  2. The SUBJECT is a real player — a signed player JWT in `Authorization`.
 *
 * The customer identity comes from the JWT and from nowhere else. There is
 * deliberately no `userId` parameter anywhere in this module: a support agent
 * that could name its own customer id could read any account in the system.
 *
 * The guard also refuses ADMIN tokens. An admin JWT would resolve to an id in
 * `admin_users`, which this module would then read as if it were a player id —
 * returning another person's data under an admin's token.
 */
@Injectable()
export class AiSupportGuard implements CanActivate {
  private readonly logger = new Logger(AiSupportGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();

    // ── 1. service key ───────────────────────────────────────────────
    const expected = this.config.get<string>('AI_SUPPORT_API_KEY');
    if (!expected) {
      // Fail CLOSED. An unset secret must not silently publish every
      // customer's wallet and KYC state to anyone who finds the URL.
      this.logger.error(
        'AI_SUPPORT_API_KEY is not set — refusing every ai-support request',
      );
      throw new ForbiddenException('AI support API is not configured');
    }
    const provided = String(req.headers['x-ai-support-key'] ?? '');
    if (!this.safeEqual(provided, expected)) {
      throw new ForbiddenException('Invalid service credentials');
    }

    // ── 2. player identity ───────────────────────────────────────────
    const raw = String(req.headers['authorization'] ?? '');
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
    if (!token) throw new UnauthorizedException('No customer token provided');

    let payload: any;
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired customer token');
    }

    // Admin tokens carry type=ADMIN (new) or a non-USER role (legacy) — the
    // same detection AdminGuard uses.
    const isAdmin =
      payload?.type === 'ADMIN' || (payload?.role && payload.role !== 'USER');
    if (isAdmin) {
      throw new ForbiddenException(
        'AI support endpoints act on behalf of a customer, not an admin',
      );
    }

    const userId = Number(payload?.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new UnauthorizedException('Token carries no customer id');
    }

    // The token may outlive the account. Resolve the player once here so every
    // service downstream can trust `req.aiSupport.userId` exists and is real.
    const [user] = await this.dataSource.query(
      `SELECT id, username, account_status FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!user) throw new UnauthorizedException('Customer not found');

    req.user = payload;
    req.aiSupport = {
      userId: Number(user.id),
      username: user.username,
      accountStatus: user.account_status,
    };

    // Audit: who was read, and when. Deliberately no response contents.
    this.logger.log(
      `ai-support ${req.method} ${req.route?.path ?? req.path} user=${user.id}`,
    );
    return true;
  }

  /** Length-independent comparison, so timing cannot reveal the key. */
  private safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
}

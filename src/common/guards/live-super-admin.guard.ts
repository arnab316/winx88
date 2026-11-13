import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * SUPER_ADMIN only, resolved live from the database.
 *
 * Use it AFTER AdminGuard, which verifies the token and populates req.user:
 *
 *   @UseGuards(AdminGuard, LiveSuperAdminGuard)
 *
 * Why not the existing SuperAdminGuard: that one reads `role` out of the JWT,
 * so an admin demoted after their token was issued keeps super-admin access
 * until it expires (15 minutes by default, longer if they refresh). For the
 * routes this guards — raw phone numbers of people who are not users of this
 * platform — that window is not acceptable. Resolved from the DB, a demotion
 * takes effect on the next request.
 *
 * The check accepts EITHER an RBAC SUPER_ADMIN role row OR the legacy
 * admin_users.role column. Both, because a restored production dump wipes the
 * RBAC tables (see migration 1910000000000) and until they are re-run and the
 * founder is re-promoted, admin_user_roles is empty — a role-table-only check
 * would lock every admin out of these routes with no way back in through the UI.
 *
 * Deliberately not cached: RbacService caches access for 30s, which is the
 * right trade for ordinary permission checks and the wrong one here. One
 * indexed primary-key lookup per request is cheap.
 */
@Injectable()
export class LiveSuperAdminGuard implements CanActivate {
  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    // AdminGuard has already verified the token and set req.user.
    const adminId = Number(req.user?.sub ?? req.admin?.id);
    if (!adminId) {
      throw new UnauthorizedException('No admin context on the request');
    }

    const rows = await this.dataSource.query(
      `SELECT 1
         FROM admin_users au
         LEFT JOIN admin_user_roles aur ON aur.admin_id = au.id
         LEFT JOIN admin_roles ar       ON ar.id = aur.role_id
        WHERE au.id = $1
          AND (ar.code = 'SUPER_ADMIN' OR au.role = 'SUPER_ADMIN')
        LIMIT 1`,
      [adminId],
    );

    if (!rows.length) {
      throw new ForbiddenException('Super admin access required');
    }

    return true;
  }
}

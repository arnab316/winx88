import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  RBAC_PERMS_KEY,
  RequiredPermission,
} from '../decorators/require-permissions.decorator';
import { RbacService } from '../../rbac/rbac.service';

/**
 * Checks the permission declared by @RequirePermissions against the admin's
 * effective permissions (resolved from the DB per request, cached). Must run
 * AFTER AdminGuard, which verifies the token and sets req.user.
 *
 * No @RequirePermissions on the route → this guard is a no-op (AdminGuard alone
 * already gated it to "any logged-in admin").
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      RBAC_PERMS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required) return true; // route declares no specific permission

    const req = ctx.switchToHttp().getRequest();
    const adminId = Number(req.user?.sub ?? req.admin?.id);
    if (!adminId) throw new UnauthorizedException('No admin context');

    const access = await this.rbac.getAccess(adminId);
    if (!this.rbac.has(access, required.resource, required.action)) {
      throw new ForbiddenException(
        `Missing permission: ${required.resource}.${required.action}`,
      );
    }
    // Make the resolved access available to handlers if they want it.
    req.rbac = access;
    return true;
  }
}

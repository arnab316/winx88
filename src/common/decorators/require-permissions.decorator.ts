import { SetMetadata } from '@nestjs/common';

export const RBAC_PERMS_KEY = 'rbac:perms';

/**
 * Declare the permission a route needs, AWS-style resource + action.
 *
 *   @RequirePermissions('users', 'update')
 *
 * Enforced by PermissionsGuard (which must run after AdminGuard). SUPER_ADMIN
 * bypasses all checks. Use together:
 *
 *   @UseGuards(AdminGuard, PermissionsGuard)
 *   @RequirePermissions('deposits', 'approve')
 */
export interface RequiredPermission {
  resource: string;
  action: string;
}

export const RequirePermissions = (resource: string, action: string) =>
  SetMetadata(RBAC_PERMS_KEY, { resource, action } as RequiredPermission);

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../common/guards/admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RbacService } from './rbac.service';

/**
 * Admin RBAC management + self introspection.
 *
 *   GET   /admin/rbac/me                      → current admin's roles+permissions (for can())
 *   GET   /admin/rbac/permissions             → permission catalog            [roles.view]
 *   GET   /admin/rbac/roles                   → list roles (+perms, members)  [roles.view]
 *   GET   /admin/rbac/roles/:id               → one role                      [roles.view]
 *   POST  /admin/rbac/roles                   → create custom role/group      [roles.create]
 *   PATCH /admin/rbac/roles/:id               → rename / describe             [roles.update]
 *   PUT   /admin/rbac/roles/:id/permissions   → set a role's permissions      [roles.update]
 *   DELETE/admin/rbac/roles/:id               → delete custom role            [roles.delete]
 *   GET   /admin/rbac/admins                  → list admins (+roles)          [admins.view]
 *   POST  /admin/rbac/admins                  → create admin + assign roles   [admins.create]
 *   PATCH /admin/rbac/admins/:id/roles        → replace an admin's roles      [admins.update]
 *   PATCH /admin/rbac/admins/:id/status       → ACTIVE / INACTIVE             [admins.update]
 */
@Controller('admin/rbac')
@UseGuards(AdminGuard, PermissionsGuard)
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  // ── self ──
  @Get('me')
  me(@Req() req: any) {
    return this.rbac.getMyAccess(Number(req.user.sub));
  }

  // ── catalog ──
  @Get('permissions')
  @RequirePermissions('roles', 'view')
  permissions() {
    return this.rbac.listPermissions();
  }

  // ── roles ──
  @Get('roles')
  @RequirePermissions('roles', 'view')
  listRoles() {
    return this.rbac.listRoles();
  }

  @Get('roles/:id')
  @RequirePermissions('roles', 'view')
  getRole(@Param('id', ParseIntPipe) id: number) {
    return this.rbac.getRole(id);
  }

  @Post('roles')
  @RequirePermissions('roles', 'create')
  createRole(
    @Req() req: any,
    @Body() dto: { code: string; name: string; description?: string; permissions?: Array<{ resource: string; action: string }> },
  ) {
    return this.rbac.createRole(dto, Number(req.user.sub));
  }

  @Patch('roles/:id')
  @RequirePermissions('roles', 'update')
  updateRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { name?: string; description?: string },
  ) {
    return this.rbac.updateRole(id, dto);
  }

  @Put('roles/:id/permissions')
  @RequirePermissions('roles', 'update')
  setRolePermissions(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { permissions: Array<{ resource: string; action: string }> },
  ) {
    return this.rbac.setRolePermissions(id, dto?.permissions ?? []);
  }

  @Delete('roles/:id')
  @RequirePermissions('roles', 'delete')
  deleteRole(@Param('id', ParseIntPipe) id: number) {
    return this.rbac.deleteRole(id);
  }

  // ── admins ──
  @Get('admins')
  @RequirePermissions('admins', 'view')
  listAdmins() {
    return this.rbac.listAdmins();
  }

  @Post('admins')
  @RequirePermissions('admins', 'create')
  createAdmin(
    @Req() req: any,
    @Body() dto: { name: string; email: string; password: string; roles?: string[] },
  ) {
    return this.rbac.createAdmin(dto, Number(req.user.sub));
  }

  @Patch('admins/:id/roles')
  @RequirePermissions('admins', 'update')
  setAdminRoles(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { roles: string[] },
  ) {
    return this.rbac.setAdminRoles(id, dto?.roles ?? [], Number(req.user.sub));
  }

  @Patch('admins/:id/status')
  @RequirePermissions('admins', 'update')
  setAdminStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { status: 'ACTIVE' | 'INACTIVE' },
  ) {
    return this.rbac.setAdminStatus(id, dto?.status);
  }
}

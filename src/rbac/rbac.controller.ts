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
import { RbacService, SectionPermission } from './rbac.service';

/** Response envelope the admin frontend expects on every RBAS endpoint. */
const ok = <T>(data: T) => ({ success: true, data });

/**
 * Admin RBAC management + self introspection.
 *
 *   GET   /admin/rbac/me                      → current admin's role+permissions
 *   GET   /admin/rbac/permissions             → permission catalog            [roles.view]
 *   GET   /admin/rbac/roles                   → list roles (+perms, members)  [roles.view]
 *   GET   /admin/rbac/roles/:id               → one role                      [roles.view]
 *   GET   /admin/rbac/roles/:id/permissions   → { roleId, roleName, permissions } [roles.view]
 *   POST  /admin/rbac/roles                   → create role (code optional)   [roles.create]
 *   PATCH /admin/rbac/roles/:id               → rename / describe             [roles.update]
 *   PUT   /admin/rbac/roles/:id/permissions   → set [{section, actions[]}]    [roles.update]
 *   DELETE/admin/rbac/roles/:id               → delete custom role            [roles.delete]
 *   GET   /admin/rbac/admins                  → list admins (+role)           [admins.view]
 *   POST  /admin/rbac/admins                  → create admin + assign roles   [admins.create]
 *   PATCH /admin/rbac/admins/:id/role         → assign ONE role (null=remove) [admins.update]
 *   PATCH /admin/rbac/admins/:id/roles        → replace role set (multi)      [admins.update]
 *   PATCH /admin/rbac/admins/:id/status       → ACTIVE / INACTIVE             [admins.update]
 *
 * Permissions travel as [{ section, actions: string[] }] — section = sidebar
 * page key (all_members, deposit, …), actions = UI capabilities on that page.
 */
@Controller('admin/rbac')
@UseGuards(AdminGuard, PermissionsGuard)
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  // ── self ──
  @Get('me')
  async me(@Req() req: any) {
    return ok(await this.rbac.getMyAccess(Number(req.user.sub)));
  }

  // ── catalog ──
  @Get('permissions')
  @RequirePermissions('roles', 'view')
  async permissions() {
    return ok(await this.rbac.listPermissions());
  }

  // ── roles ──
  @Get('roles')
  @RequirePermissions('roles', 'view')
  async listRoles() {
    return ok(await this.rbac.listRoles());
  }

  @Get('roles/:id')
  @RequirePermissions('roles', 'view')
  async getRole(@Param('id', ParseIntPipe) id: number) {
    return ok(await this.rbac.getRole(id));
  }

  @Get('roles/:id/permissions')
  @RequirePermissions('roles', 'view')
  async getRolePermissions(@Param('id', ParseIntPipe) id: number) {
    return ok(await this.rbac.getRolePermissions(id));
  }

  @Post('roles')
  @RequirePermissions('roles', 'create')
  async createRole(
    @Req() req: any,
    @Body() dto: { name: string; code?: string; description?: string; permissions?: SectionPermission[] },
  ) {
    return ok(await this.rbac.createRole(dto, Number(req.user.sub)));
  }

  @Patch('roles/:id')
  @RequirePermissions('roles', 'update')
  async updateRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { name?: string; description?: string },
  ) {
    return ok(await this.rbac.updateRole(id, dto));
  }

  @Put('roles/:id/permissions')
  @RequirePermissions('roles', 'update')
  async setRolePermissions(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { permissions: SectionPermission[] },
  ) {
    return ok(await this.rbac.setRolePermissions(id, dto?.permissions ?? []));
  }

  @Delete('roles/:id')
  @RequirePermissions('roles', 'delete')
  async deleteRole(@Param('id', ParseIntPipe) id: number) {
    return ok(await this.rbac.deleteRole(id));
  }

  // ── admins ──
  @Get('admins')
  @RequirePermissions('admins', 'view')
  async listAdmins() {
    return ok(await this.rbac.listAdmins());
  }

  @Post('admins')
  @RequirePermissions('admins', 'create')
  async createAdmin(
    @Req() req: any,
    @Body() dto: { name: string; email: string; password: string; roles?: string[] },
  ) {
    return ok(await this.rbac.createAdmin(dto, Number(req.user.sub)));
  }

  @Patch('admins/:id/role')
  @RequirePermissions('admins', 'update')
  async setAdminRole(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { role_id: number | string | null },
  ) {
    const roleId =
      dto?.role_id === null || dto?.role_id === undefined || dto?.role_id === ''
        ? null
        : Number(dto.role_id);
    return ok(await this.rbac.setAdminRole(id, roleId, Number(req.user.sub)));
  }

  @Patch('admins/:id/roles')
  @RequirePermissions('admins', 'update')
  async setAdminRoles(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { roles: string[] },
  ) {
    return ok(await this.rbac.setAdminRoles(id, dto?.roles ?? [], Number(req.user.sub)));
  }

  @Patch('admins/:id/status')
  @RequirePermissions('admins', 'update')
  async setAdminStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { status: 'ACTIVE' | 'INACTIVE' },
  ) {
    return ok(await this.rbac.setAdminStatus(id, dto?.status));
  }

  // PATCH /admin/rbac/admins/:id  → edit name / email / password.
  // SUPER_ADMIN only (enforced in the service, resolved live from the DB —
  // not a permission, so it can't be granted to a normal role).
  @Patch('admins/:id')
  async editAdmin(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { name?: string; email?: string; password?: string },
  ) {
    return ok(await this.rbac.editAdmin(id, dto, Number(req.user.sub)));
  }

  // DELETE /admin/rbac/admins/:id → delete any admin. SUPER_ADMIN only.
  @Delete('admins/:id')
  async deleteAdmin(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return ok(await this.rbac.deleteAdmin(id, Number(req.user.sub)));
  }
}

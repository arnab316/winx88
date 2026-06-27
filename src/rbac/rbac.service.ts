import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

export interface AdminAccess {
  roles: string[];                         // role codes, e.g. ['CS']
  isSuperAdmin: boolean;
  permissions: Record<string, string[]>;   // AWS-style: { users: ['view','update'] }
  flat: Set<string>;                       // { 'users.view', 'users.update' }
}

@Injectable()
export class RbacService {
  constructor(private readonly dataSource: DataSource) {}

  // ── Per-admin access cache (resolve-from-DB with a short TTL) ──
  private cache = new Map<number, { at: number; access: AdminAccess }>();
  private readonly TTL_MS = 30_000;

  /** Effective access for an admin (cached). */
  async getAccess(adminId: number): Promise<AdminAccess> {
    const hit = this.cache.get(adminId);
    if (hit && Date.now() - hit.at < this.TTL_MS) return hit.access;
    const access = await this.loadAccess(adminId);
    this.cache.set(adminId, { at: Date.now(), access });
    return access;
  }

  /** Drop cached access so the next request re-resolves (after role changes). */
  invalidate(adminId?: number): void {
    if (adminId === undefined) this.cache.clear();
    else this.cache.delete(adminId);
  }

  has(access: AdminAccess, resource: string, action: string): boolean {
    return access.isSuperAdmin || access.flat.has(`${resource}.${action}`);
  }

  private async loadAccess(adminId: number): Promise<AdminAccess> {
    const roleRows = await this.dataSource.query(
      `SELECT ar.code
         FROM admin_user_roles aur
         JOIN admin_roles ar ON ar.id = aur.role_id
        WHERE aur.admin_id = $1`,
      [adminId],
    );
    const roles: string[] = roleRows.map((r: any) => r.code);
    const isSuperAdmin = roles.includes('SUPER_ADMIN');

    const permRows = await this.dataSource.query(
      `SELECT DISTINCT p.resource, p.action
         FROM admin_user_roles aur
         JOIN admin_role_permissions arp ON arp.role_id = aur.role_id
         JOIN admin_permissions p        ON p.id = arp.permission_id
        WHERE aur.admin_id = $1`,
      [adminId],
    );

    const permissions: Record<string, string[]> = {};
    const flat = new Set<string>();
    for (const r of permRows) {
      (permissions[r.resource] ??= []).push(r.action);
      flat.add(`${r.resource}.${r.action}`);
    }
    return { roles, isSuperAdmin, permissions, flat };
  }

  /** For GET /admin/rbac/me — the shape the frontend `can()` helper consumes. */
  async getMyAccess(adminId: number) {
    const a = await this.getAccess(adminId);
    return { roles: a.roles, isSuperAdmin: a.isSuperAdmin, permissions: a.permissions };
  }

  // ════════════════════════════════════════════════════════════════════════
  // PERMISSION CATALOG
  // ════════════════════════════════════════════════════════════════════════
  async listPermissions() {
    const rows = await this.dataSource.query(
      `SELECT id, resource, action, description
         FROM admin_permissions ORDER BY resource, action`,
    );
    // grouped { resource: [{action, description, id}] } for easy UI rendering
    const grouped: Record<string, any[]> = {};
    for (const r of rows) {
      (grouped[r.resource] ??= []).push({
        id: Number(r.id), action: r.action, description: r.description,
      });
    }
    return { flat: rows.map((r: any) => ({ ...r, id: Number(r.id) })), grouped };
  }

  // ════════════════════════════════════════════════════════════════════════
  // ROLES
  // ════════════════════════════════════════════════════════════════════════
  async listRoles() {
    return this.dataSource.query(
      `SELECT r.id, r.code, r.name, r.description, r.is_system, r.created_at,
              (SELECT COUNT(*)::int FROM admin_user_roles aur WHERE aur.role_id = r.id) AS member_count,
              COALESCE((
                SELECT json_agg(json_build_object('resource', p.resource, 'action', p.action)
                                ORDER BY p.resource, p.action)
                FROM admin_role_permissions arp
                JOIN admin_permissions p ON p.id = arp.permission_id
                WHERE arp.role_id = r.id
              ), '[]'::json) AS permissions
         FROM admin_roles r
         ORDER BY r.is_system DESC, r.name ASC`,
    );
  }

  async getRole(id: number) {
    const [role] = await this.dataSource.query(
      `SELECT id, code, name, description, is_system, created_at FROM admin_roles WHERE id = $1`,
      [id],
    );
    if (!role) throw new NotFoundException('Role not found');
    role.permissions = await this.dataSource.query(
      `SELECT p.id, p.resource, p.action
         FROM admin_role_permissions arp
         JOIN admin_permissions p ON p.id = arp.permission_id
        WHERE arp.role_id = $1
        ORDER BY p.resource, p.action`,
      [id],
    );
    return role;
  }

  async createRole(
    dto: { code: string; name: string; description?: string; permissions?: Array<{ resource: string; action: string }> },
    adminId: number,
  ) {
    const code = dto.code?.trim().toUpperCase();
    if (!code || !/^[A-Z0-9_]+$/.test(code)) {
      throw new BadRequestException('code must be UPPER_SNAKE_CASE (A-Z, 0-9, _)');
    }
    if (!dto.name?.trim()) throw new BadRequestException('name is required');

    try {
      const [role] = await this.dataSource.query(
        `INSERT INTO admin_roles (code, name, description, is_system, created_by_admin_id)
         VALUES ($1, $2, $3, FALSE, $4) RETURNING id, code, name, description, is_system`,
        [code, dto.name.trim(), dto.description ?? null, adminId],
      );
      if (dto.permissions?.length) {
        await this.setRolePermissions(Number(role.id), dto.permissions);
      }
      return this.getRole(Number(role.id));
    } catch (e: any) {
      if (e.code === '23505') throw new BadRequestException(`Role "${code}" already exists`);
      throw e;
    }
  }

  async updateRole(id: number, dto: { name?: string; description?: string }) {
    const [role] = await this.dataSource.query(`SELECT id FROM admin_roles WHERE id = $1`, [id]);
    if (!role) throw new NotFoundException('Role not found');

    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (dto.name !== undefined) { fields.push(`name = $${i++}`); vals.push(dto.name); }
    if (dto.description !== undefined) { fields.push(`description = $${i++}`); vals.push(dto.description); }
    if (!fields.length) throw new BadRequestException('No fields to update');
    fields.push(`updated_at = NOW()`);
    vals.push(id);
    await this.dataSource.query(
      `UPDATE admin_roles SET ${fields.join(', ')} WHERE id = $${i}`,
      vals,
    );
    return this.getRole(id);
  }

  async deleteRole(id: number) {
    const [role] = await this.dataSource.query(
      `SELECT id, code, is_system FROM admin_roles WHERE id = $1`,
      [id],
    );
    if (!role) throw new NotFoundException('Role not found');
    if (role.is_system) throw new ForbiddenException(`System role "${role.code}" cannot be deleted`);

    const [{ c }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM admin_user_roles WHERE role_id = $1`,
      [id],
    );
    if (c > 0) {
      throw new BadRequestException(
        `Cannot delete: ${c} admin(s) still hold this role. Reassign them first.`,
      );
    }
    await this.dataSource.query(`DELETE FROM admin_roles WHERE id = $1`, [id]);
    this.invalidate();
    return { message: 'Role deleted' };
  }

  /** Replace a role's permission set wholesale. */
  async setRolePermissions(
    roleId: number,
    permissions: Array<{ resource: string; action: string }>,
  ) {
    const [role] = await this.dataSource.query(
      `SELECT id, code, is_system FROM admin_roles WHERE id = $1`,
      [roleId],
    );
    if (!role) throw new NotFoundException('Role not found');
    if (role.code === 'SUPER_ADMIN') {
      throw new ForbiddenException('SUPER_ADMIN permissions cannot be edited (it has full access)');
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`DELETE FROM admin_role_permissions WHERE role_id = $1`, [roleId]);
      for (const p of permissions ?? []) {
        await qr.query(
          `INSERT INTO admin_role_permissions (role_id, permission_id)
           SELECT $1, id FROM admin_permissions WHERE resource = $2 AND action = $3
           ON CONFLICT DO NOTHING`,
          [roleId, p.resource, p.action],
        );
      }
      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
    this.invalidate(); // permission set changed → drop all cached access
    return this.getRole(roleId);
  }

  // ════════════════════════════════════════════════════════════════════════
  // ADMIN ACCOUNTS + ROLE ASSIGNMENT
  // ════════════════════════════════════════════════════════════════════════
  async listAdmins() {
    return this.dataSource.query(
      `SELECT au.id, au.name, au.email, au.role AS legacy_role, au.status,
              au.created_at,
              COALESCE((
                SELECT json_agg(ar.code ORDER BY ar.code)
                FROM admin_user_roles aur
                JOIN admin_roles ar ON ar.id = aur.role_id
                WHERE aur.admin_id = au.id
              ), '[]'::json) AS roles
         FROM admin_users au
         ORDER BY au.created_at DESC`,
    );
  }

  async createAdmin(
    dto: { name: string; email: string; password: string; roles?: string[] },
    creatorAdminId: number,
  ) {
    if (!dto.name?.trim() || !dto.email?.trim() || !dto.password) {
      throw new BadRequestException('name, email and password are required');
    }
    const roleCodes = (dto.roles ?? []).map((r) => r.trim().toUpperCase()).filter(Boolean);
    if (!roleCodes.length) throw new BadRequestException('At least one role is required');

    const valid = await this.dataSource.query(
      `SELECT code FROM admin_roles WHERE code = ANY($1)`,
      [roleCodes],
    );
    const validCodes = valid.map((r: any) => r.code);
    const unknown = roleCodes.filter((c) => !validCodes.includes(c));
    if (unknown.length) throw new BadRequestException(`Unknown role(s): ${unknown.join(', ')}`);

    const hashed = await bcrypt.hash(dto.password, 10);
    // Keep the legacy `role` column populated with a sensible primary role so
    // older code paths still work (highest-priority code the admin holds).
    const primary = this.primaryRole(roleCodes);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      let admin;
      try {
        [admin] = await qr.query(
          `INSERT INTO admin_users (name, email, password, role)
           VALUES ($1, $2, $3, $4) RETURNING id, name, email, role, status`,
          [dto.name.trim(), dto.email.trim().toLowerCase(), hashed, primary],
        );
      } catch (e: any) {
        if (e.code === '23505') throw new BadRequestException('An admin with this email already exists');
        if (e.code === '23514') {
          // legacy admin_users_role_check only allows ADMIN/SUPER_ADMIN/OPERATOR
          throw new BadRequestException(
            `Primary role "${primary}" not allowed by admin_users.role check constraint. ` +
            `Run the constraint relaxation (see notes) or assign a legacy-compatible primary role.`,
          );
        }
        throw e;
      }
      for (const code of roleCodes) {
        await qr.query(
          `INSERT INTO admin_user_roles (admin_id, role_id, assigned_by_admin_id)
           SELECT $1, id, $3 FROM admin_roles WHERE code = $2
           ON CONFLICT DO NOTHING`,
          [admin.id, code, creatorAdminId],
        );
      }
      await qr.commitTransaction();
      this.invalidate(Number(admin.id));
      return { ...admin, roles: roleCodes };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  /** Replace an admin's roles wholesale. */
  async setAdminRoles(adminId: number, roles: string[], actorAdminId: number) {
    const [admin] = await this.dataSource.query(`SELECT id FROM admin_users WHERE id = $1`, [adminId]);
    if (!admin) throw new NotFoundException('Admin not found');

    const roleCodes = (roles ?? []).map((r) => r.trim().toUpperCase()).filter(Boolean);
    if (!roleCodes.length) throw new BadRequestException('At least one role is required');

    const valid = await this.dataSource.query(`SELECT code FROM admin_roles WHERE code = ANY($1)`, [roleCodes]);
    const validCodes = valid.map((r: any) => r.code);
    const unknown = roleCodes.filter((c) => !validCodes.includes(c));
    if (unknown.length) throw new BadRequestException(`Unknown role(s): ${unknown.join(', ')}`);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`DELETE FROM admin_user_roles WHERE admin_id = $1`, [adminId]);
      for (const code of roleCodes) {
        await qr.query(
          `INSERT INTO admin_user_roles (admin_id, role_id, assigned_by_admin_id)
           SELECT $1, id, $3 FROM admin_roles WHERE code = $2 ON CONFLICT DO NOTHING`,
          [adminId, code, actorAdminId],
        );
      }
      // keep legacy primary role in sync (best-effort; ignore check-constraint failures)
      try {
        await qr.query(`UPDATE admin_users SET role = $1, updated_at = NOW() WHERE id = $2`, [
          this.primaryRole(roleCodes), adminId,
        ]);
      } catch { /* legacy check constraint may reject CS/SUPPORT/TL — non-fatal */ }
      await qr.commitTransaction();
      this.invalidate(adminId);
      return { adminId, roles: roleCodes };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  async setAdminStatus(adminId: number, status: 'ACTIVE' | 'INACTIVE') {
    if (!['ACTIVE', 'INACTIVE'].includes(status)) {
      throw new BadRequestException('status must be ACTIVE or INACTIVE');
    }
    const res = await this.dataSource.query(
      `UPDATE admin_users SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status`,
      [status, adminId],
    );
    if (!res.length) throw new NotFoundException('Admin not found');
    this.invalidate(adminId);
    return res[0];
  }

  // Highest-priority legacy-compatible code for the admin_users.role column.
  private primaryRole(codes: string[]): string {
    const order = ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'];
    for (const o of order) if (codes.includes(o)) return o;
    // New-style roles (CS/SUPPORT/TL/custom) aren't in the legacy enum; fall
    // back to ADMIN so the legacy column stays valid. RBAC uses admin_user_roles.
    return 'ADMIN';
  }
}

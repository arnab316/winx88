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
  permissions: Record<string, string[]>;   // { all_members: ['view','filter'] }
  flat: Set<string>;                       // { 'all_members.view', … }
}

/** The shape the frontend consumes: [{ section, actions: [...] }, …] */
export interface SectionPermission {
  section: string;
  actions: string[];
}

const KEY_RX = /^[a-z0-9_]+$/i;

function toSectionArray(map: Record<string, string[]>): SectionPermission[] {
  return Object.entries(map)
    .filter(([section]) => !['roles', 'admins'].includes(section)) // internal
    .map(([section, actions]) => ({ section, actions: [...actions].sort() }))
    .sort((a, b) => a.section.localeCompare(b.section));
}

/**
 * Normalize a permissions payload to flat (section, action) pairs. Accepts the
 * frontend shape [{ section, actions: [...] }] and, for backward compat, flat
 * [{ resource|section, action }] items.
 */
function toPairs(
  permissions: Array<{ section?: string; resource?: string; actions?: string[]; action?: string }>,
): Array<{ section: string; action: string }> {
  const pairs: Array<{ section: string; action: string }> = [];
  for (const p of permissions ?? []) {
    const section = (p.section ?? p.resource ?? '').trim();
    const actions = p.actions ?? (p.action ? [p.action] : []);
    if (!section || !KEY_RX.test(section)) {
      throw new BadRequestException(`Invalid section key: "${section}"`);
    }
    for (const raw of actions) {
      const action = String(raw ?? '').trim();
      if (!action || !KEY_RX.test(action)) {
        throw new BadRequestException(`Invalid action "${raw}" for section "${section}"`);
      }
      pairs.push({ section, action });
    }
  }
  return pairs;
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

  /** For GET /admin/rbac/me — mirrors the `admin` object of /auth/admin-login. */
  async getMyAccess(adminId: number) {
    const a = await this.getAccess(adminId);
    const [primary] = await this.dataSource.query(
      `SELECT ar.id, ar.code, ar.name
         FROM admin_user_roles aur
         JOIN admin_roles ar ON ar.id = aur.role_id
        WHERE aur.admin_id = $1
        ORDER BY (ar.code = 'SUPER_ADMIN') DESC, aur.assigned_at ASC
        LIMIT 1`,
      [adminId],
    );
    return {
      roles: a.roles,
      role: primary ? { id: Number(primary.id), name: primary.name, code: primary.code } : null,
      is_super_admin: a.isSuperAdmin,
      isSuperAdmin: a.isSuperAdmin, // legacy key
      permissions: toSectionArray(a.permissions),
    };
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
    const roles = await this.dataSource.query(
      `SELECT r.id, r.code, r.name, r.description, r.is_system, r.created_at,
              (SELECT COUNT(*)::int FROM admin_user_roles aur WHERE aur.role_id = r.id) AS assigned_admins
         FROM admin_roles r
         ORDER BY r.is_system DESC, r.name ASC`,
    );
    const perms = await this.dataSource.query(
      `SELECT arp.role_id, p.resource, p.action
         FROM admin_role_permissions arp
         JOIN admin_permissions p ON p.id = arp.permission_id
        ORDER BY p.resource, p.action`,
    );
    const byRole = new Map<number, Record<string, string[]>>();
    for (const r of perms) {
      const map = byRole.get(Number(r.role_id)) ?? {};
      (map[r.resource] ??= []).push(r.action);
      byRole.set(Number(r.role_id), map);
    }
    return roles.map((r: any) => ({
      ...r,
      id: Number(r.id),
      permissions: toSectionArray(byRole.get(Number(r.id)) ?? {}),
    }));
  }

  async getRole(id: number) {
    const [role] = await this.dataSource.query(
      `SELECT id, code, name, description, is_system, created_at,
              (SELECT COUNT(*)::int FROM admin_user_roles aur WHERE aur.role_id = admin_roles.id) AS assigned_admins
         FROM admin_roles WHERE id = $1`,
      [id],
    );
    if (!role) throw new NotFoundException('Role not found');
    const rows = await this.dataSource.query(
      `SELECT p.resource, p.action
         FROM admin_role_permissions arp
         JOIN admin_permissions p ON p.id = arp.permission_id
        WHERE arp.role_id = $1
        ORDER BY p.resource, p.action`,
      [id],
    );
    const map: Record<string, string[]> = {};
    for (const r of rows) (map[r.resource] ??= []).push(r.action);
    return { ...role, id: Number(role.id), permissions: toSectionArray(map) };
  }

  /** GET /admin/rbac/roles/:id/permissions — the shape the RBAS config UI edits. */
  async getRolePermissions(id: number) {
    const role = await this.getRole(id);
    return { roleId: role.id, roleName: role.name, permissions: role.permissions };
  }

  async createRole(
    dto: { code?: string; name: string; description?: string; permissions?: SectionPermission[] },
    adminId: number,
  ) {
    if (!dto.name?.trim()) throw new BadRequestException('name is required');
    // code is optional — derived from the name when omitted ("Finance Manager"
    // → FINANCE_MANAGER) so the frontend can send just { name, description }.
    const code = (dto.code?.trim() || dto.name.trim().replace(/[^a-zA-Z0-9]+/g, '_'))
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
    if (!code || !/^[A-Z0-9_]+$/.test(code)) {
      throw new BadRequestException('code must be UPPER_SNAKE_CASE (A-Z, 0-9, _)');
    }

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

  /**
   * Replace a role's permission set wholesale. Takes the frontend shape
   * [{ section, actions: [...] }] (flat { resource|section, action } items
   * also accepted). Unknown section/action keys are added to the catalog on
   * the fly so a frontend registry update never silently drops a grant.
   */
  async setRolePermissions(
    roleId: number,
    permissions: Array<{ section?: string; resource?: string; actions?: string[]; action?: string }>,
  ) {
    const [role] = await this.dataSource.query(
      `SELECT id, code, is_system FROM admin_roles WHERE id = $1`,
      [roleId],
    );
    if (!role) throw new NotFoundException('Role not found');
    if (role.code === 'SUPER_ADMIN') {
      throw new ForbiddenException('SUPER_ADMIN permissions cannot be edited (it has full access)');
    }

    const pairs = toPairs(permissions);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`DELETE FROM admin_role_permissions WHERE role_id = $1`, [roleId]);
      for (const p of pairs) {
        await qr.query(
          `INSERT INTO admin_permissions (resource, action)
           VALUES ($1, $2) ON CONFLICT (resource, action) DO NOTHING`,
          [p.section, p.action],
        );
        await qr.query(
          `INSERT INTO admin_role_permissions (role_id, permission_id)
           SELECT $1, id FROM admin_permissions WHERE resource = $2 AND action = $3
           ON CONFLICT DO NOTHING`,
          [roleId, p.section, p.action],
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
    const rows = await this.dataSource.query(
      `SELECT au.id, au.name, au.email, au.role AS legacy_role, au.status,
              au.created_at,
              pr.role_id, pr.role_name, pr.role_code,
              COALESCE((
                SELECT json_agg(ar.code ORDER BY ar.code)
                FROM admin_user_roles aur
                JOIN admin_roles ar ON ar.id = aur.role_id
                WHERE aur.admin_id = au.id
              ), '[]'::json) AS roles
         FROM admin_users au
         LEFT JOIN LATERAL (
           SELECT ar.id AS role_id, ar.name AS role_name, ar.code AS role_code
             FROM admin_user_roles aur
             JOIN admin_roles ar ON ar.id = aur.role_id
            WHERE aur.admin_id = au.id
            ORDER BY (ar.code = 'SUPER_ADMIN') DESC, aur.assigned_at ASC
            LIMIT 1
         ) pr ON TRUE
         ORDER BY au.created_at DESC`,
    );
    return rows.map((r: any) => ({
      ...r,
      id: Number(r.id),
      role_id: r.role_id === null ? null : Number(r.role_id),
    }));
  }

  /**
   * Map role identifiers from the frontend to canonical role codes. Accepts
   * the code itself ("TL", "team_leader"), or the display name ("Team Lead",
   * "Team Leader") — the admin panel sends whichever it has. Multi-word input
   * is normalized the same way createRole derives codes ("Team Leader" →
   * TEAM_LEADER), and display names are matched case-insensitively, since the
   * two can legitimately differ (e.g. a renamed role keeps its original code).
   */
  private async resolveRoleCodes(roles: string[]): Promise<string[]> {
    const inputs = (roles ?? []).map((r) => String(r).trim()).filter(Boolean);
    if (!inputs.length) throw new BadRequestException('At least one role is required');

    const all = await this.dataSource.query(`SELECT code, name FROM admin_roles`);
    const toCode = (s: string) =>
      s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();

    const codes: string[] = [];
    const unknown: string[] = [];
    for (const input of inputs) {
      const match = all.find(
        (r: any) =>
          r.code === toCode(input) ||
          r.name.trim().toUpperCase() === input.toUpperCase(),
      );
      if (match) {
        if (!codes.includes(match.code)) codes.push(match.code);
      } else {
        unknown.push(input);
      }
    }
    if (unknown.length) throw new BadRequestException(`Unknown role(s): ${unknown.join(', ')}`);
    return codes;
  }

  async createAdmin(
    dto: { name: string; email: string; password: string; roles?: string[] },
    creatorAdminId: number,
  ) {
    if (!dto.name?.trim() || !dto.email?.trim() || !dto.password) {
      throw new BadRequestException('name, email and password are required');
    }
    const roleCodes = await this.resolveRoleCodes(dto.roles ?? []);

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

  /**
   * PATCH /admin/rbac/admins/:id/role — the single-role model the admin panel
   * uses: the given role replaces ALL of the admin's roles; null removes them
   * (the admin keeps their account but loses every permission).
   */
  async setAdminRole(adminId: number, roleId: number | null, actorAdminId: number) {
    if (adminId === actorAdminId) {
      throw new ForbiddenException('You cannot change your own role');
    }
    const [admin] = await this.dataSource.query(
      `SELECT id FROM admin_users WHERE id = $1`, [adminId],
    );
    if (!admin) throw new NotFoundException('Admin not found');

    if (roleId === null || roleId === undefined) {
      await this.dataSource.query(
        `DELETE FROM admin_user_roles WHERE admin_id = $1`, [adminId],
      );
      this.invalidate(adminId);
      return { adminId, role_id: null, role_name: null };
    }
    if (!Number.isInteger(roleId)) throw new BadRequestException('role_id must be a role id or null');

    const [role] = await this.dataSource.query(
      `SELECT id, code, name FROM admin_roles WHERE id = $1`, [roleId],
    );
    if (!role) throw new NotFoundException('Role not found');

    await this.setAdminRoles(adminId, [role.code], actorAdminId);
    return { adminId, role_id: Number(role.id), role_name: role.name };
  }

  /** Replace an admin's roles wholesale. */
  async setAdminRoles(adminId: number, roles: string[], actorAdminId: number) {
    const [admin] = await this.dataSource.query(`SELECT id FROM admin_users WHERE id = $1`, [adminId]);
    if (!admin) throw new NotFoundException('Admin not found');

    const roleCodes = await this.resolveRoleCodes(roles ?? []);

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

  /** Only a SUPER_ADMIN may pass. Resolved live from the DB (not the JWT), so
   *  a demoted admin loses access immediately. */
  private async assertSuperAdmin(actorAdminId: number): Promise<void> {
    const access = await this.getAccess(actorAdminId);
    if (!access.isSuperAdmin) {
      throw new ForbiddenException('Only a SUPER_ADMIN can perform this action');
    }
  }

  private async isSuperAdminRow(adminId: number): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM admin_user_roles aur
         JOIN admin_roles ar ON ar.id = aur.role_id
        WHERE aur.admin_id = $1 AND ar.code = 'SUPER_ADMIN' LIMIT 1`,
      [adminId],
    );
    return rows.length > 0;
  }

  /**
   * PATCH /admin/rbac/admins/:id — SUPER_ADMIN only. Edit an admin's
   * name / email / password (roles/status have their own endpoints).
   */
  async editAdmin(
    adminId: number,
    dto: { name?: string; email?: string; password?: string },
    actorAdminId: number,
  ) {
    await this.assertSuperAdmin(actorAdminId);

    const [admin] = await this.dataSource.query(
      `SELECT id FROM admin_users WHERE id = $1`, [adminId],
    );
    if (!admin) throw new NotFoundException('Admin not found');

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw new BadRequestException('name cannot be empty');
      fields.push(`name = $${i++}`); values.push(dto.name.trim());
    }
    if (dto.email !== undefined) {
      if (!dto.email.trim()) throw new BadRequestException('email cannot be empty');
      fields.push(`email = $${i++}`); values.push(dto.email.trim().toLowerCase());
    }
    if (dto.password !== undefined && dto.password.trim()) {
      if (dto.password.length < 6) throw new BadRequestException('Password must be at least 6 characters');
      fields.push(`password = $${i++}`); values.push(await bcrypt.hash(dto.password, 10));
    }
    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(adminId);
    let res;
    try {
      res = await this.dataSource.query(
        `UPDATE admin_users SET ${fields.join(', ')} WHERE id = $${i}
         RETURNING id, name, email, role, status`,
        values,
      );
    } catch (e: any) {
      if (e.code === '23505') throw new BadRequestException('An admin with this email already exists');
      throw e;
    }
    this.invalidate(adminId);
    // UPDATE…RETURNING returns [rows, affectedCount] in TypeORM — unwrap to
    // the single row so the response is an object, not an array.
    const rows = Array.isArray(res[0]) ? res[0] : res;
    return rows[0];
  }

  /**
   * DELETE /admin/rbac/admins/:id — SUPER_ADMIN only. Hard-deletes the admin
   * (cascades their tokens + role assignments; audit references like
   * decided_by_admin_id are set NULL by the FKs). Guards: can't delete
   * yourself, and can't remove the last SUPER_ADMIN.
   */
  async deleteAdmin(adminId: number, actorAdminId: number) {
    await this.assertSuperAdmin(actorAdminId);
    if (adminId === actorAdminId) {
      throw new ForbiddenException('You cannot delete your own account');
    }

    const [admin] = await this.dataSource.query(
      `SELECT id, name, email FROM admin_users WHERE id = $1`, [adminId],
    );
    if (!admin) throw new NotFoundException('Admin not found');

    if (await this.isSuperAdminRow(adminId)) {
      const [{ c }] = await this.dataSource.query(
        `SELECT COUNT(DISTINCT aur.admin_id)::int AS c
           FROM admin_user_roles aur
           JOIN admin_roles ar ON ar.id = aur.role_id
          WHERE ar.code = 'SUPER_ADMIN'`,
      );
      if (c <= 1) throw new BadRequestException('Cannot delete the last SUPER_ADMIN');
    }

    await this.dataSource.query(`DELETE FROM admin_users WHERE id = $1`, [adminId]);
    this.invalidate(adminId);
    return { deleted: true, id: adminId, name: admin.name, email: admin.email };
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

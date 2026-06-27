import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AWS IAM-style RBAC for admin_users.
 *
 *   admin_permissions       — catalog of resource/action pairs (users.view, …)
 *   admin_roles             — named roles / "groups" (SUPER_ADMIN, ADMIN, CS, …)
 *   admin_role_permissions  — which permissions a role grants
 *   admin_user_roles        — an admin can hold MANY roles (= AWS groups);
 *                             effective permissions = union of all role perms
 *
 * SUPER_ADMIN is treated as a wildcard in code (bypasses checks) AND seeded
 * with every permission here, so it works either way. The legacy
 * admin_users.role column is kept and back-filled into admin_user_roles so the
 * existing accounts keep working. Idempotent.
 */
export class AdminRbac1910000000000 implements MigrationInterface {
  name = 'AdminRbac1910000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── 1. Tables ──
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.admin_permissions (
        id          BIGSERIAL PRIMARY KEY,
        resource    VARCHAR(60)  NOT NULL,
        action      VARCHAR(40)  NOT NULL,
        description VARCHAR(200),
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT admin_permissions_unique UNIQUE (resource, action)
      );
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.admin_roles (
        id                  BIGSERIAL PRIMARY KEY,
        code                VARCHAR(40)  NOT NULL UNIQUE,
        name                VARCHAR(120) NOT NULL,
        description         VARCHAR(255),
        is_system           BOOLEAN      NOT NULL DEFAULT FALSE,
        created_by_admin_id BIGINT,
        created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.admin_role_permissions (
        role_id       BIGINT NOT NULL REFERENCES public.admin_roles(id)       ON DELETE CASCADE,
        permission_id BIGINT NOT NULL REFERENCES public.admin_permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      );
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.admin_user_roles (
        admin_id             BIGINT NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
        role_id              BIGINT NOT NULL REFERENCES public.admin_roles(id)  ON DELETE CASCADE,
        assigned_by_admin_id BIGINT,
        assigned_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (admin_id, role_id)
      );
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_admin_user_roles_admin ON public.admin_user_roles(admin_id);`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_admin_role_perms_role ON public.admin_role_permissions(role_id);`);

    // ── 2. Permission catalog ──
    await q.query(`
      INSERT INTO public.admin_permissions (resource, action, description) VALUES
        ('users','view','View members'),
        ('users','create','Create members'),
        ('users','update','Edit members'),
        ('users','delete','Delete members'),
        ('users','change_password','Reset member password'),
        ('deposits','view','View deposits'),
        ('deposits','approve','Approve deposits'),
        ('deposits','reject','Reject deposits'),
        ('withdrawals','view','View withdrawals'),
        ('withdrawals','approve','Approve withdrawals'),
        ('withdrawals','reject','Reject withdrawals'),
        ('reports','view','View reports'),
        ('reports','export','Export reports'),
        ('referrals','view','View referrals'),
        ('referrals','update','Manage referrals (disqualify)'),
        ('affiliates','view','View affiliates'),
        ('affiliates','update','Manage affiliates'),
        ('affiliates','approve','Approve affiliates'),
        ('promotions','view','View promotions'),
        ('promotions','create','Create promotions'),
        ('promotions','update','Edit promotions'),
        ('promotions','delete','Delete promotions'),
        ('member_groups','view','View member groups'),
        ('member_groups','create','Create member groups'),
        ('member_groups','update','Edit member groups'),
        ('member_groups','delete','Delete member groups'),
        ('vip','view','View VIP tiers'),
        ('vip','update','Edit VIP tiers'),
        ('sports','view','View sportsbook'),
        ('sports','update','Manage sportsbook'),
        ('game_history','view','View game/bet history'),
        ('turnover','view','View turnover'),
        ('turnover','update','Adjust turnover'),
        ('kyc','view','View KYC'),
        ('kyc','approve','Approve KYC'),
        ('kyc','reject','Reject KYC'),
        ('admins','view','View admin accounts'),
        ('admins','create','Create admin accounts'),
        ('admins','update','Edit admin accounts'),
        ('admins','delete','Delete admin accounts'),
        ('roles','view','View roles & permissions'),
        ('roles','create','Create roles'),
        ('roles','update','Edit roles & permissions'),
        ('roles','delete','Delete roles')
      ON CONFLICT (resource, action) DO NOTHING;
    `);

    // ── 3. System roles ──
    await q.query(`
      INSERT INTO public.admin_roles (code, name, description, is_system) VALUES
        ('SUPER_ADMIN','Super Admin','Full access to everything', TRUE),
        ('ADMIN','Admin','Broad operational access (no RBAC management)', TRUE),
        ('TL','Team Lead','Approves deposits/withdrawals; oversees support', TRUE),
        ('CS','Customer Support','Member support: view/edit members, view finance', TRUE),
        ('SUPPORT','Support','Read-mostly support access', TRUE),
        ('OPERATOR','Operator','Limited operational access', TRUE)
      ON CONFLICT (code) DO NOTHING;
    `);

    // ── 4. role → permission grants ──
    // SUPER_ADMIN: every permission (also wildcard-bypassed in code).
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code = 'SUPER_ADMIN'
      ON CONFLICT DO NOTHING;
    `);
    // ADMIN: broad operational access, but NOT admin-account management
    // (admins.*) nor RBAC management (roles.*) — those are SUPER_ADMIN-only.
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code = 'ADMIN'
        AND p.resource NOT IN ('roles', 'admins')
      ON CONFLICT DO NOTHING;
    `);
    // Self-heal: if an earlier run of this seed granted admins.*/roles.* to
    // ADMIN, revoke them (no-op on a fresh install).
    await q.query(`
      DELETE FROM public.admin_role_permissions arp
      USING public.admin_roles r, public.admin_permissions p
      WHERE arp.role_id = r.id AND arp.permission_id = p.id
        AND r.code = 'ADMIN' AND p.resource IN ('roles', 'admins');
    `);
    // TL
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code = 'TL' AND (p.resource, p.action) IN (
        ('users','view'),('users','update'),
        ('deposits','view'),('deposits','approve'),('deposits','reject'),
        ('withdrawals','view'),('withdrawals','approve'),('withdrawals','reject'),
        ('reports','view'),('reports','export'),
        ('referrals','view'),('affiliates','view'),
        ('kyc','view'),('kyc','approve'),('kyc','reject'),
        ('game_history','view'),('turnover','view')
      )
      ON CONFLICT DO NOTHING;
    `);
    // CS
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code = 'CS' AND (p.resource, p.action) IN (
        ('users','view'),('users','update'),('users','change_password'),
        ('deposits','view'),('withdrawals','view'),
        ('reports','view'),('referrals','view'),
        ('kyc','view'),('game_history','view'),('turnover','view')
      )
      ON CONFLICT DO NOTHING;
    `);
    // SUPPORT
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code = 'SUPPORT' AND (p.resource, p.action) IN (
        ('users','view'),('deposits','view'),('withdrawals','view'),
        ('reports','view'),('game_history','view')
      )
      ON CONFLICT DO NOTHING;
    `);
    // OPERATOR
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code = 'OPERATOR' AND (p.resource, p.action) IN (
        ('users','view'),
        ('deposits','view'),('deposits','approve'),
        ('withdrawals','view'),('withdrawals','approve'),
        ('reports','view')
      )
      ON CONFLICT DO NOTHING;
    `);

    // ── 5. Back-fill: give every existing admin the role matching its legacy
    //      admin_users.role column (codes line up 1:1). ──
    await q.query(`
      INSERT INTO public.admin_user_roles (admin_id, role_id)
      SELECT au.id, ar.id
        FROM public.admin_users au
        JOIN public.admin_roles ar ON ar.code = au.role
      ON CONFLICT DO NOTHING;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS public.admin_user_roles;`);
    await q.query(`DROP TABLE IF EXISTS public.admin_role_permissions;`);
    await q.query(`DROP TABLE IF EXISTS public.admin_roles;`);
    await q.query(`DROP TABLE IF EXISTS public.admin_permissions;`);
  }
}

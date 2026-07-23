import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin remarks (internal notes) on a member's profile.
 *
 *   - `user_remarks` is a LIST of notes per user (add as many as needed), each
 *     stamped with the admin who created it and the admin who last edited it.
 *     admin ids reference `admin_users` (a SEPARATE table from `users`), so —
 *     per the winX88 rule on admin-id columns — they carry NO users(id) FK.
 *   - Four new actions under the existing `all_members` RBAC section drive who
 *     can view / add / edit / delete remarks. SUPER_ADMIN (wildcard) always
 *     passes; ADMIN is granted them here (mirrors migration 1930's "ADMIN gets
 *     every section" stance). Any other role only gets them if a SUPER_ADMIN
 *     grants them via the RBAC role editor.
 *
 * Idempotent.
 */
export class UserMemberRemarks2020000000000 implements MigrationInterface {
  name = 'UserMemberRemarks2020000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── Remarks table ──
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.user_remarks (
        id                   SERIAL PRIMARY KEY,
        user_id              INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        remark               TEXT NOT NULL,
        -- admin_users.id — intentionally NO FK (admins live in a separate table)
        created_by_admin_id  INTEGER,
        updated_by_admin_id  INTEGER,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_user_remarks_user_id
        ON public.user_remarks (user_id, created_at DESC);
    `);

    // ── New RBAC actions on the all_members section ──
    await q.query(`
      INSERT INTO public.admin_permissions (resource, action, description) VALUES
        ('all_members','view_remarks','View member remarks'),
        ('all_members','add_remark','Add member remark'),
        ('all_members','edit_remark','Edit member remark'),
        ('all_members','delete_remark','Delete member remark')
      ON CONFLICT (resource, action) DO NOTHING;
    `);

    // SUPER_ADMIN: everything (also wildcard-bypassed in code).
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
       WHERE r.code = 'SUPER_ADMIN'
         AND p.resource = 'all_members'
         AND p.action IN ('view_remarks','add_remark','edit_remark','delete_remark')
      ON CONFLICT DO NOTHING;
    `);
    // ADMIN: gets the remark actions too (never roles/admins — unchanged).
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
       WHERE r.code = 'ADMIN'
         AND p.resource = 'all_members'
         AND p.action IN ('view_remarks','add_remark','edit_remark','delete_remark')
      ON CONFLICT DO NOTHING;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DELETE FROM public.admin_permissions
       WHERE resource = 'all_members'
         AND action IN ('view_remarks','add_remark','edit_remark','delete_remark');
    `);
    await q.query(`DROP TABLE IF EXISTS public.user_remarks;`);
  }
}

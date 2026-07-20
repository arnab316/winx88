import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RBAC catalog entries for the admin Report page (member summary report):
 *   reports.view   — see the Report page / query the summary
 *   reports.export — download the CSV export
 *
 * Granted to SUPER_ADMIN and ADMIN; other roles get it via the RBAS UI.
 * Idempotent.
 */
export class ReportsPermissions1940000000000 implements MigrationInterface {
  name = 'ReportsPermissions1940000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      INSERT INTO public.admin_permissions (resource, action, description) VALUES
        ('reports','view','View member reports'),
        ('reports','export','Export member reports')
      ON CONFLICT (resource, action) DO NOTHING;
    `);
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code IN ('SUPER_ADMIN', 'ADMIN') AND p.resource = 'reports'
      ON CONFLICT DO NOTHING;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM public.admin_permissions WHERE resource = 'reports';`);
  }
}

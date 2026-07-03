import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Re-key the admin RBAC permission catalog to the frontend sidebar sections.
 *
 * The admin panel drives access control per SIDEBAR SECTION (page) + ACTION
 * (button/feature on that page), e.g. `all_members.adjust_wallet`. The
 * original catalog (migration 1910000000000) used backend resource names
 * (`users`, `deposits`, …) which don't line up with the UI. This migration:
 *
 *   1. Seeds the frontend permissions registry (section → actions) into
 *      admin_permissions (resource = section key).
 *   2. Translates every existing role grant old-resource → new-section so
 *      system AND custom roles keep equivalent access.
 *   3. Deletes the old resource rows (grants cascade), EXCEPT `roles.*` and
 *      `admins.*` which guard the RBAC management endpoints themselves.
 *   4. Re-grants SUPER_ADMIN everything and ADMIN every section (still no
 *      `roles`/`admins` grants — RBAC management stays SUPER_ADMIN-only).
 *
 * Idempotent.
 */
export class RbacFrontendSections1930000000000 implements MigrationInterface {
  name = 'RbacFrontendSections1930000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── 1. Frontend sections registry ──
    await q.query(`
      INSERT INTO public.admin_permissions (resource, action, description) VALUES
        ('dashboard','view','View dashboard'),
        ('banners','view','View banners'),
        ('banners','create','Create banners'),
        ('banners','edit','Edit banners'),
        ('banners','delete','Delete banners'),
        ('announcements','view','View announcements'),
        ('announcements','create','Create announcements'),
        ('announcements','edit','Edit announcements'),
        ('announcements','delete','Delete announcements'),
        ('all_members','view','View member list'),
        ('all_members','filter','Use filters & search'),
        ('all_members','edit','Edit member profile'),
        ('all_members','adjust_wallet','Adjust wallet balance'),
        ('all_members','adjust_coins','Adjust VIP coins'),
        ('all_members','view_transactions','View transactions'),
        ('all_members','view_bets','View bet history'),
        ('all_members','view_compliance','View compliance data'),
        ('kyc_verification','view','View KYC requests'),
        ('kyc_verification','approve','Approve KYC'),
        ('kyc_verification','reject','Reject KYC'),
        ('member_group','view','View member groups'),
        ('member_group','create','Create member groups'),
        ('member_group','edit','Edit member groups'),
        ('member_group','delete','Delete member groups'),
        ('agents','view','View agents'),
        ('agents','create','Create agents'),
        ('agents','edit','Edit agents'),
        ('agents','delete','Delete agents'),
        ('deposit','view','View deposits'),
        ('deposit','approve','Approve deposits'),
        ('deposit','reject','Reject deposits'),
        ('deposit','filter','Use deposit filters'),
        ('withdraw','view','View withdrawals'),
        ('withdraw','approve','Approve withdrawals'),
        ('withdraw','reject','Reject withdrawals'),
        ('withdraw','filter','Use withdrawal filters'),
        ('promotion_settings','view','View promotion settings'),
        ('promotion_settings','create','Create promotions'),
        ('promotion_settings','edit','Edit promotions'),
        ('promotion_settings','delete','Delete promotions'),
        ('promotion_cms','view','View promotion CMS'),
        ('promotion_cms','create','Create promotion CMS entries'),
        ('promotion_cms','edit','Edit promotion CMS entries'),
        ('promotion_cms','delete','Delete promotion CMS entries'),
        ('promotion_statistic','view','View promotion statistics'),
        ('promotion_statistic','export','Export promotion statistics'),
        ('vip_settings','view','View VIP settings'),
        ('vip_settings','edit','Edit VIP settings'),
        ('vip_level_group','view','View VIP level groups'),
        ('vip_level_group','create','Create VIP level groups'),
        ('vip_level_group','edit','Edit VIP level groups'),
        ('vip_level_group','delete','Delete VIP level groups'),
        ('referral_settings','view','View referral settings'),
        ('referral_settings','edit','Edit referral settings'),
        ('referral_info','view','View referral info'),
        ('referral_info','export','Export referral info'),
        ('referral_search','view','View referral search'),
        ('referral_search','filter','Use referral search filters'),
        ('games','view','View games'),
        ('games','create','Create games'),
        ('games','edit','Edit games'),
        ('games','delete','Delete games'),
        ('game_rounds','view','View game rounds'),
        ('game_rounds','filter','Use game round filters'),
        ('jackpots','view','View jackpots'),
        ('jackpots','edit','Edit jackpots'),
        ('hot_suggestions','view','View hot suggestions'),
        ('hot_suggestions','create','Create hot suggestions'),
        ('hot_suggestions','edit','Edit hot suggestions'),
        ('hot_suggestions','delete','Delete hot suggestions')
      ON CONFLICT (resource, action) DO NOTHING;
    `);

    // ── 2. Translate existing grants old-resource → new-section (any role,
    //      system or custom). "view" also grants the section's "filter" where
    //      one exists, matching what those roles could already do in the UI. ──
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT arp.role_id, np.id
        FROM (VALUES
          ('users','view',              'all_members','view'),
          ('users','view',              'all_members','filter'),
          ('users','update',            'all_members','edit'),
          ('users','change_password',   'all_members','edit'),
          ('deposits','view',           'deposit','view'),
          ('deposits','view',           'deposit','filter'),
          ('deposits','approve',        'deposit','approve'),
          ('deposits','reject',         'deposit','reject'),
          ('withdrawals','view',        'withdraw','view'),
          ('withdrawals','view',        'withdraw','filter'),
          ('withdrawals','approve',     'withdraw','approve'),
          ('withdrawals','reject',      'withdraw','reject'),
          ('kyc','view',                'kyc_verification','view'),
          ('kyc','approve',             'kyc_verification','approve'),
          ('kyc','reject',              'kyc_verification','reject'),
          ('member_groups','view',      'member_group','view'),
          ('member_groups','create',    'member_group','create'),
          ('member_groups','update',    'member_group','edit'),
          ('member_groups','delete',    'member_group','delete'),
          ('promotions','view',         'promotion_settings','view'),
          ('promotions','create',       'promotion_settings','create'),
          ('promotions','update',       'promotion_settings','edit'),
          ('promotions','delete',       'promotion_settings','delete'),
          ('vip','view',                'vip_settings','view'),
          ('vip','update',              'vip_settings','edit'),
          ('referrals','view',          'referral_info','view'),
          ('referrals','view',          'referral_search','view'),
          ('referrals','view',          'referral_search','filter'),
          ('referrals','update',        'referral_settings','view'),
          ('referrals','update',        'referral_settings','edit'),
          ('game_history','view',       'game_rounds','view'),
          ('game_history','view',       'game_rounds','filter'),
          ('affiliates','view',         'agents','view'),
          ('affiliates','update',       'agents','edit'),
          ('affiliates','approve',      'agents','edit'),
          ('reports','view',            'promotion_statistic','view'),
          ('reports','export',          'promotion_statistic','export')
        ) AS map(old_resource, old_action, new_resource, new_action)
        JOIN public.admin_permissions op
          ON op.resource = map.old_resource AND op.action = map.old_action
        JOIN public.admin_role_permissions arp
          ON arp.permission_id = op.id
        JOIN public.admin_permissions np
          ON np.resource = map.new_resource AND np.action = map.new_action
      ON CONFLICT DO NOTHING;
    `);

    // ── 3. Drop the old backend-resource catalog (grants cascade). `roles`
    //      and `admins` stay: they guard /admin/rbac/* itself. Sections with
    //      no UI equivalent (sports, turnover) are dropped along with them. ──
    await q.query(`
      DELETE FROM public.admin_permissions
       WHERE resource IN (
         'users','deposits','withdrawals','reports','referrals','affiliates',
         'promotions','member_groups','vip','sports','game_history','turnover','kyc'
       );
    `);

    // ── 4. SUPER_ADMIN: everything (also wildcard-bypassed in code). ──
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code = 'SUPER_ADMIN'
      ON CONFLICT DO NOTHING;
    `);
    // ADMIN: every section, but never RBAC management (roles.*/admins.*).
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code = 'ADMIN'
        AND p.resource NOT IN ('roles', 'admins')
      ON CONFLICT DO NOTHING;
    `);
    // Every other system role can at least see the dashboard.
    await q.query(`
      INSERT INTO public.admin_role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM public.admin_roles r, public.admin_permissions p
      WHERE r.code IN ('TL','CS','SUPPORT','OPERATOR')
        AND p.resource = 'dashboard' AND p.action = 'view'
      ON CONFLICT DO NOTHING;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Removes the section-keyed rows (grants cascade). The old backend-resource
    // catalog can be restored by re-running migration 1910000000000's seed.
    await q.query(`
      DELETE FROM public.admin_permissions
       WHERE resource IN (
         'dashboard','banners','announcements','all_members','kyc_verification',
         'member_group','agents','deposit','withdraw','promotion_settings',
         'promotion_cms','promotion_statistic','vip_settings','vip_level_group',
         'referral_settings','referral_info','referral_search','games',
         'game_rounds','jackpots','hot_suggestions'
       );
    `);
  }
}

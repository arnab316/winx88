/**
 * How the Track log describes known admin actions.
 *
 * Every admin write is logged whether or not it appears here — an unlisted
 * route is recorded with a generic "PATCH /some/path" summary. A rule adds:
 *
 *   action   a stable key, for filtering (USER_EDIT, DEPOSIT_DECIDE, …)
 *   label    the human sentence shown in the Track tab
 *   targets  how to find the affected player(s) when the URL / body does not
 *            carry a userId directly (a deposit id, a claim id, …)
 *
 * `path` is the Express route pattern exactly as declared (controller prefix +
 * method path), e.g. `/wallet/admin/deposits/:id/decide`.
 */

export interface RuleCtx {
  params: Record<string, any>;
  body: Record<string, any>;
  query: Record<string, any>;
}

export interface SqlRunner {
  query(sql: string, params?: any[]): Promise<any>;
}

export interface ActivityRule {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  action: string;
  label: (c: RuleCtx) => string;
  targets?: (c: RuleCtx, db: SqlRunner) => Promise<number[]>;
}

const money = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? `৳${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : String(v ?? '');
};

/**
 * Which way an adjustment moved the balance.
 *
 * `/wallet/admin/adjust` takes a SIGNED amount (+ credit, − debit), and
 * `৳-500` alone reads as a typo at a glance. Saying "Debit ৳500" makes the
 * direction unmissable in an audit trail, which is the one place it matters.
 */
const direction = (v: any) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'Credit' : 'Debit';
};

/** Signed amount rendered as "Credit ৳500" / "Debit ৳500" (sign carried by the word). */
const signedMoney = (v: any) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return money(v);
  const dir = direction(n);
  return dir ? `${dir} ${money(Math.abs(n))}` : money(n);
};
const verb = (action: any) =>
  String(action ?? '').toUpperCase() === 'APPROVE' ? 'approved'
    : String(action ?? '').toUpperCase() === 'REJECT' ? 'rejected'
      : String(action ?? '').toLowerCase() || 'decided';

/** `SELECT <cols> FROM <table> WHERE id = $1` → every non-null id in those columns. */
const lookup = (table: string, cols: string[], idOf: (c: RuleCtx) => any) =>
  async (c: RuleCtx, db: SqlRunner): Promise<number[]> => {
    const id = idOf(c);
    if (id === undefined || id === null || id === '') return [];
    const rows = await db.query(`SELECT ${cols.join(', ')} FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
    if (!rows.length) return [];
    return cols.map((k) => Number(rows[0][k])).filter((n) => Number.isFinite(n) && n > 0);
  };

const byParamId = (table: string, ...cols: string[]) => lookup(table, cols, (c) => c.params.id);

export const ACTIVITY_RULES: ActivityRule[] = [
  // ── Player profile ──────────────────────────────────────────────
  {
    method: 'PATCH', path: '/user/admin/:userId', action: 'USER_EDIT',
    // The interceptor appends the before → after field list.
    label: () => 'Edited player profile',
  },
  { method: 'POST', path: '/user/admin/:userId/remarks', action: 'REMARK_ADD', label: (c) => `Added remark: "${String(c.body.remark ?? '').slice(0, 80)}"` },
  { method: 'PATCH', path: '/user/admin/:userId/remarks/:remarkId', action: 'REMARK_EDIT', label: () => 'Edited a remark' },
  { method: 'DELETE', path: '/user/admin/:userId/remarks/:remarkId', action: 'REMARK_DELETE', label: () => 'Deleted a remark' },
  { method: 'POST', path: '/user/admin/:userId/phone', action: 'PHONE_ADD', label: (c) => `Added phone ${c.body.phoneNumber ?? ''}`.trim() },
  { method: 'PATCH', path: '/user/admin/:userId/phone/:phoneId', action: 'PHONE_EDIT', label: (c) => `Changed phone number to ${c.body.phoneNumber ?? ''}`.trim() },
  { method: 'PATCH', path: '/user/admin/:userId/phone/:phoneId/primary', action: 'PHONE_PRIMARY', label: () => 'Set primary phone number' },
  { method: 'PATCH', path: '/user/admin/:userId/phone/:phoneId/verify', action: 'PHONE_VERIFY', label: () => 'Marked phone number verified' },
  { method: 'DELETE', path: '/user/admin/:userId/phone/:phoneId', action: 'PHONE_DELETE', label: () => 'Deleted a phone number' },

  // ── Money ───────────────────────────────────────────────────────
  {
    method: 'POST', path: '/wallet/admin/manual-deposit', action: 'MANUAL_DEPOSIT',
    label: (c) => `Manual deposit ${money(c.body.amount)}${c.body.trxNumber ? ` (TRX ${c.body.trxNumber})` : ''}`,
  },
  {
    method: 'POST', path: '/wallet/admin/adjust', action: 'BALANCE_ADJUST',
    label: (c) =>
      `Balance adjustment — ${signedMoney(c.body.amount)}` +
      `${c.body.adjustmentType ? ` (${c.body.adjustmentType})` : ''}` +
      `${c.body.description ? ` — ${c.body.description}` : ''}`,
  },
  {
    method: 'POST', path: '/wallet/admin/deposits/:id/decide', action: 'DEPOSIT_DECIDE',
    label: (c) => `Deposit #${c.params.id} ${verb(c.body.action)}` +
      (c.body.rejectionReason ? ` — ${c.body.rejectionReason}` : ''),
    targets: byParamId('deposits', 'user_id'),
  },
  { method: 'POST', path: '/wallet/admin/deposits/:id/reopen', action: 'DEPOSIT_REOPEN', label: (c) => `Reopened deposit #${c.params.id}`, targets: byParamId('deposits', 'user_id') },
  // NOTE: the source build also tracked PATCH /wallet/admin/deposits/:id/test
  // (mark an approved deposit as a test). That endpoint does not exist in this
  // codebase, so the rule was dropped rather than left as a path that can
  // never match.
  {
    method: 'POST', path: '/wallet/admin/withdrawals/:id/decide', action: 'WITHDRAWAL_DECIDE',
    label: (c) => `Withdrawal #${c.params.id} ${verb(c.body.action)}${c.body.rejectionReason ? ` — ${c.body.rejectionReason}` : ''}`,
    targets: byParamId('withdrawals', 'user_id'),
  },
  {
    method: 'POST', path: '/coins/admin/adjust', action: 'COINS_ADJUST',
    // Coins are a count, not currency — show the direction but no ৳ symbol.
    label: (c) =>
      `Coins adjusted — ${direction(c.body.amount) || 'no change'} ${Math.abs(Number(c.body.amount) || 0)}`.trim() +
      `${c.body.reason ? ` — ${c.body.reason}` : ''}`,
  },

  // ── KYC ─────────────────────────────────────────────────────────
  {
    method: 'PATCH', path: '/verification/admin/:id/review', action: 'KYC_REVIEW',
    label: (c) => `KYC ${verb(c.body.action)}${c.body.rejectionReason ? ` — ${c.body.rejectionReason}` : ''}`,
    targets: byParamId('user_verifications', 'user_id'),
  },
  { method: 'PATCH', path: '/verification/admin/:id/under-review', action: 'KYC_UNDER_REVIEW', label: () => 'KYC marked under review', targets: byParamId('user_verifications', 'user_id') },

  // ── Turnover ────────────────────────────────────────────────────
  { method: 'POST', path: '/turnover/:id/complete', action: 'TURNOVER_COMPLETE', label: (c) => `Force-completed turnover requirement #${c.params.id}`, targets: byParamId('turnover_requirements', 'user_id') },

  // ── Promotions ──────────────────────────────────────────────────
  { method: 'POST', path: '/promotion/admin/grant-manual', action: 'BONUS_GRANT', label: (c) => `Granted manual bonus ${money(c.body.amount ?? c.body.bonusAmount)}` },
  ...(['approve', 'cancel', 'forfeit'] as const).map((k): ActivityRule => ({
    method: 'POST', path: `/promotion/admin/${k}-claim`, action: `CLAIM_${k.toUpperCase()}`,
    label: (c) => `Promotion claim #${c.body.claimId ?? ''} ${k === 'approve' ? 'approved' : k === 'cancel' ? 'cancelled' : 'forfeited'}`,
    targets: lookup('user_promotion_claims', ['user_id'], (c) => c.body.claimId),
  })),

  // ── Refer-a-friend ──────────────────────────────────────────────
  { method: 'PATCH', path: '/admin/referrals/:id/disqualify', action: 'REFERRAL_DISQUALIFY', label: (c) => `Disqualified referral #${c.params.id}${c.body.reason ? ` — ${c.body.reason}` : ''}`, targets: byParamId('friend_referrals', 'referrer_user_id', 'referee_user_id') },
  { method: 'POST', path: '/admin/referrals/:id/recompute', action: 'REFERRAL_RECOMPUTE', label: (c) => `Recomputed referral #${c.params.id}`, targets: byParamId('friend_referrals', 'referrer_user_id', 'referee_user_id') },

  // ── Affiliate ───────────────────────────────────────────────────
  { method: 'POST', path: '/affiliate/admin/create', action: 'AFFILIATE_CREATE', label: (c) => `Created affiliate ${c.body.username ?? ''}`.trim() },
  { method: 'POST', path: '/affiliate/admin/applications/:id/decide', action: 'AFFILIATE_APPLICATION', label: (c) => `Affiliate application ${verb(c.body.action)}`, targets: byParamId('affiliate_applications', 'user_id') },
  { method: 'POST', path: '/affiliate/admin/transfers/:id/decide', action: 'AFFILIATE_TRANSFER', label: (c) => `Affiliate transfer #${c.params.id} ${verb(c.body.action)}`, targets: byParamId('affiliate_transfers', 'from_user_id', 'to_user_id') },
  { method: 'PATCH', path: '/affiliate/admin/:userId/status', action: 'AFFILIATE_STATUS', label: (c) => `Affiliate status → ${c.body.status ?? ''}`.trim() },
  { method: 'PATCH', path: '/affiliate/admin/:userId/group', action: 'AFFILIATE_GROUP', label: () => 'Changed affiliate group' },
  { method: 'POST', path: '/affiliate/admin/:userId/password', action: 'AFFILIATE_PASSWORD', label: () => 'Reset affiliate password' },
  // Commission adjustments are signed too, so they get the same Credit/Debit
  // treatment as a balance adjustment.
  { method: 'POST', path: '/affiliate/admin/:userId/commission-adjust', action: 'AFFILIATE_COMMISSION', label: (c) => `Adjusted affiliate commission — ${signedMoney(c.body.amount)}` },

  // ── Notifications ───────────────────────────────────────────────
  {
    method: 'POST', path: '/notifications/admin/send', action: 'NOTIFICATION_SEND',
    label: (c) => `Sent notification ${c.body.eventKey ?? 'ADMIN_BROADCAST'}${c.body.title ? `: "${String(c.body.title).slice(0, 80)}"` : ''}` +
      (!c.body.usernames?.length && !c.body.userIds?.length ? ' to ALL active players' : ''),
  },
];

const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;
const BY_KEY = new Map(ACTIVITY_RULES.map((r) => [key(r.method, r.path), r]));

export function findRule(method: string, path: string): ActivityRule | undefined {
  return BY_KEY.get(key(method, path));
}

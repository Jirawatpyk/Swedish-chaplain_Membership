/**
 * The PINNED § 4.1 permission matrix — transcribed from the authoritative
 * design table (docs/superpowers/specs/2026-08-10-rbac-permission-system-design.md
 * § 4.1, v2 rev 3) so tests assert against the DESIGN, not against the
 * implementation's own data (spec 016 FR-002: 40 keys; ADD-only evolution —
 * never rename or repurpose).
 *
 * `super_admin: true` on every row reflects the evaluator BYPASS (contract E1);
 * the super_admin BUNDLE itself must hold only the non-superAdminOnly keys
 * (FR-003: no bundle contains a superAdminOnly key — SA reaches those via the
 * bypass, not via bundle content).
 */

export interface PinnedRow {
  readonly key: string;
  readonly superAdminOnly?: true;
  readonly sensitive?: 'money' | 'pii';
  readonly admin: boolean;
  readonly manager: boolean;
  readonly marketing: boolean;
}

const row = (
  key: string,
  admin: boolean,
  manager: boolean,
  marketing: boolean,
  flags: { superAdminOnly?: true; sensitive?: 'money' | 'pii' } = {},
): PinnedRow => ({ key, admin, manager, marketing, ...flags });

export const PINNED_MATRIX: readonly PinnedRow[] = [
  row('dashboard.view', true, true, true),
  row('members.read', true, true, true),
  row('members.write', true, false, false, { sensitive: 'pii' }),
  row('members.bulk', true, false, false, { sensitive: 'pii' }),
  row('members.pii_sensitive', true, false, false, { sensitive: 'pii' }),
  row('members.erasure', false, false, false, { superAdminOnly: true, sensitive: 'pii' }),
  row('members.erasure_log_read', false, false, false, { superAdminOnly: true, sensitive: 'pii' }),
  row('contacts.read', true, true, true),
  row('contacts.write', true, false, false, { sensitive: 'pii' }),
  // 108 PR-D (FR-030 / data-model § 4) — "manage contact marketing audience":
  // switch a contact's marketing state on/off. Granted to admin + marketing;
  // manager sees the state read-only (FR-034). Confers NO other contact edit.
  row('contacts.marketing', true, false, true, { sensitive: 'pii' }),
  row('directory.export', true, true, false, { sensitive: 'pii' }),
  row('plans.read', true, true, false),
  row('plans.write', true, false, false, { sensitive: 'money' }),
  row('plans.clone', true, false, false, { sensitive: 'money' }),
  row('invoicing.read', true, true, false),
  row('invoicing.write', true, false, false, { sensitive: 'money' }),
  row('invoicing.issue', true, false, false, { sensitive: 'money' }),
  row('invoicing.void', true, false, false, { sensitive: 'money' }),
  row('invoicing.receipt', true, false, false, { sensitive: 'money' }),
  row('credit_notes.write', true, false, false, { sensitive: 'money' }),
  row('refunds.write', true, false, false, { sensitive: 'money' }),
  row('payments.read', true, true, false),
  row('renewals.read', true, true, false),
  row('renewals.write', true, false, false, { sensitive: 'money' }),
  row('broadcasts.read', true, true, true),
  row('broadcasts.write', true, false, true),
  row('broadcasts.send', true, false, true),
  row('events.read', true, true, true),
  row('events.write', true, false, true),
  row('events.relink', true, false, false, { sensitive: 'money' }),
  row('events.erasure', false, false, false, { superAdminOnly: true, sensitive: 'pii' }),
  row('insights.engagement', true, true, true),
  row('insights.finance', true, true, false, { sensitive: 'money' }),
  row('insights.activity_unredacted', true, false, false, { sensitive: 'pii' }),
  row('users.manage', false, false, false, { superAdminOnly: true }),
  row('users.member_accounts', true, false, false, { sensitive: 'pii' }),
  row('audit.read', false, false, false, { superAdminOnly: true }),
  row('settings.invoicing', false, false, false, { superAdminOnly: true, sensitive: 'money' }),
  row('settings.renewal_schedules', true, false, false),
  row('broadcasts.clear_halt', true, false, false),
  row('settings.broadcasts', true, false, false),
  row('settings.integrations', true, false, false),
];

export const PINNED_KEYS: readonly string[] = PINNED_MATRIX.map((r) => r.key);

export const PINNED_SUPER_ADMIN_ONLY: readonly string[] = PINNED_MATRIX.filter(
  (r) => r.superAdminOnly,
).map((r) => r.key);

/** Dashboard widget permissions backing the landing invariant (design § 8). */
export const WIDGET_KEYS: readonly string[] = ['insights.engagement', 'insights.finance'];

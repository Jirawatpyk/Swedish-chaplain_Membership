/**
 * Permission catalogue — the pinned § 4.1 key set (016-rbac-permissions FR-002).
 *
 * Pure data, Domain layer — no framework imports. The catalogue is the single
 * source of the KEY VOCABULARY; per-role grants live in `role-bundles.ts`.
 *
 * Rules (design § 4.1, ADD-only evolution):
 *   - Keys are `<module>.<action>`, DOT-separated — never the legacy colon
 *     `Resource` grammar (`policies.ts`), which coexists until PR 5.
 *   - Keys may be ADDED (route inventory may surface more); existing keys are
 *     NEVER renamed or repurposed.
 *   - `superAdminOnly` keys are refused by the evaluator for every other role
 *     regardless of bundle content (FR-003); a Domain test proves no bundle
 *     carries one.
 *   - `sensitive` drives the review checklist on bundle diffs (design § 4.2):
 *     'money' = the key gates an amount-bearing or irreversible document
 *     action; 'pii' = it gates personal-data read/write/egress.
 *
 * The § 4.1 parity test (tests/unit/auth/permissions/permission-catalogue.test.ts)
 * pins this file to the design table — a drifting edit fails the suite.
 */

export interface CatalogueEntry {
  readonly key: string;
  readonly superAdminOnly?: true;
  readonly sensitive?: 'money' | 'pii';
}

const CATALOGUE_RAW = [
  { key: 'dashboard.view' },
  { key: 'members.read' },
  { key: 'members.write', sensitive: 'pii' },
  { key: 'members.bulk', sensitive: 'pii' },
  { key: 'members.pii_sensitive', sensitive: 'pii' },
  { key: 'members.erasure', superAdminOnly: true, sensitive: 'pii' },
  { key: 'members.erasure_log_read', superAdminOnly: true, sensitive: 'pii' },
  { key: 'contacts.read' },
  { key: 'contacts.write', sensitive: 'pii' },
  { key: 'directory.export', sensitive: 'pii' },
  { key: 'plans.read' },
  { key: 'plans.write', sensitive: 'money' },
  { key: 'plans.clone', sensitive: 'money' },
  { key: 'invoicing.read' },
  { key: 'invoicing.write', sensitive: 'money' },
  { key: 'invoicing.issue', sensitive: 'money' },
  { key: 'invoicing.void', sensitive: 'money' },
  { key: 'invoicing.receipt', sensitive: 'money' },
  { key: 'credit_notes.write', sensitive: 'money' },
  { key: 'refunds.write', sensitive: 'money' },
  { key: 'payments.read' },
  { key: 'renewals.read' },
  { key: 'renewals.write', sensitive: 'money' },
  { key: 'broadcasts.read' },
  { key: 'broadcasts.write' },
  { key: 'broadcasts.send' },
  { key: 'events.read' },
  { key: 'events.write' },
  { key: 'events.relink', sensitive: 'money' },
  { key: 'events.erasure', superAdminOnly: true, sensitive: 'pii' },
  { key: 'insights.engagement' },
  { key: 'insights.finance', sensitive: 'money' },
  { key: 'insights.activity_unredacted', sensitive: 'pii' },
  { key: 'users.manage', superAdminOnly: true },
  { key: 'users.member_accounts', sensitive: 'pii' },
  { key: 'audit.read', superAdminOnly: true },
  { key: 'settings.invoicing', superAdminOnly: true, sensitive: 'money' },
  { key: 'settings.renewal_schedules' },
  { key: 'settings.broadcasts' },
  { key: 'settings.integrations' },
] as const satisfies readonly CatalogueEntry[];

/** Literal union of the 40 pinned keys — call sites pass LITERALS only. */
export type PermissionKey = (typeof CATALOGUE_RAW)[number]['key'];

/**
 * The catalogue as `CatalogueEntry[]` (optional flags readable). The literal
 * key union above is preserved separately via `CATALOGUE_RAW`; consumers that
 * need `superAdminOnly`/`sensitive` iterate this typed view.
 */
export const PERMISSION_CATALOGUE: readonly CatalogueEntry[] = CATALOGUE_RAW;

/** Keys the evaluator refuses for every role except `super_admin` (FR-003). */
export const SUPER_ADMIN_ONLY_KEYS: ReadonlySet<PermissionKey> = new Set(
  CATALOGUE_RAW.filter((entry) => 'superAdminOnly' in entry).map(
    (entry) => entry.key,
  ),
);

/** Every catalogue key — the `super_admin` PermissionSet derivation (E1). */
export const ALL_PERMISSION_KEYS: ReadonlySet<PermissionKey> = new Set(
  CATALOGUE_RAW.map((entry) => entry.key),
);

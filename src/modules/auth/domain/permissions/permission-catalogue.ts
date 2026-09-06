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
  // ENFORCED since 108 PR-D: the Marketing audience page
  // (`/admin/marketing/audience`, FR-035) is gated on this key — the first
  // dedicated contacts surface. Contact reads on the member-detail page still
  // ride `members.read`, so revoking this key hides the audience page and the
  // ⌘K entry for it but NOT the contacts shown on a member's own page.
  // 108 PR-D (code-review finding 8) — `sensitive: 'pii'`. Before this feature
  // `contacts.read` gated one member's contacts at a time; it now also gates
  // `/admin/marketing/audience`, a TENANT-WIDE listing of every live contact's
  // name and email, 50 per page. The flag is what reviewers and gates key on to
  // decide a surface is PII-bearing, so leaving it unset would make a future
  // bundle change or a new surface behind this key read as non-sensitive and
  // skip the PII review path. It grants no less than before — `manager` and
  // `marketing` keep the key; only its classification is corrected.
  { key: 'contacts.read', sensitive: 'pii' },
  { key: 'contacts.write', sensitive: 'pii' },
  // 108 PR-D (FR-030) — "manage contact marketing audience": switch a
  // contact's marketing state on/off (staff toggle on the member page and
  // the Marketing audience page). Deliberately SEPARATE from
  // `contacts.write`: the marketing role holds this key and must NOT gain
  // the name/email/phone edit that `contacts.write` gates (spec US4 AS6).
  // `sensitive: 'pii'` because it writes a per-person preference.
  { key: 'contacts.marketing', sensitive: 'pii' },
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
  // UNENFORCED VOCABULARY (016 post-ship review, below-cap): checked by no
  // gate — the invoice payment timeline is gated by `invoicing.read`, so
  // granting this key opens nothing today. Same standing rule as
  // `contacts.read` above.
  { key: 'payments.read' },
  { key: 'renewals.read' },
  { key: 'renewals.write', sensitive: 'money' },
  { key: 'broadcasts.read' },
  { key: 'broadcasts.write' },
  { key: 'broadcasts.send' },
  // 018 DECISION (spec 010 § Requirements amendment, 2026-08-15) — clearing a
  // deliverability HALT is split out of `broadcasts.write` and narrowed to the
  // admin tier. The halt fires at >5% complaint rate and protects tenant-wide
  // sender reputation; marketing is the role that benefits from lifting it, so
  // marketing clearing its own halt is self-review. Marketing reached this
  // action only through the hard-coded-'admin' bridge defect (see 017/#334),
  // never through a decision.
  { key: 'broadcasts.clear_halt' },
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

/**
 * Role bundles — the pinned § 4.1 per-role grants (016-rbac-permissions FR-002).
 *
 * Pure data, Domain layer. `ROLE_BUNDLES` is the single source of authorization
 * truth on the flag-ON leg; the § 4.1 parity test pins every cell.
 *
 * Shape notes:
 *   - `super_admin` and `admin` hold every NON-superAdminOnly key. That is the
 *     § 4.1 table's admin column verbatim today; superAdminOnly keys reach
 *     `super_admin` via the evaluator BYPASS (E1), never via bundle content —
 *     FR-003's "no bundle contains a superAdminOnly key" holds for ALL five
 *     bundles including super_admin's own.
 *   - `manager` / `marketing` are explicit lists (the review artefact for any
 *     future bundle diff — the `sensitive` flags on changed keys drive the
 *     review checklist, design § 4.2).
 *   - `member` is EMPTY: member-portal authorization is untouched by 016.
 */

import type { Role } from '../role';
import {
  ALL_PERMISSION_KEYS,
  SUPER_ADMIN_ONLY_KEYS,
  type PermissionKey,
} from './permission-catalogue';

const NON_SUPER_ADMIN_ONLY_KEYS: readonly PermissionKey[] = [...ALL_PERMISSION_KEYS].filter(
  (key) => !SUPER_ADMIN_ONLY_KEYS.has(key),
);

const MANAGER_KEYS: readonly PermissionKey[] = [
  'dashboard.view',
  'members.read',
  // `contacts.read` + `payments.read` are UNENFORCED vocabulary today (no
  // gate checks them — see the notes in permission-catalogue.ts). They stay
  // granted for § 4.1 parity, but editing THEM changes nothing: contact
  // access rides `members.read`, the payment timeline rides `invoicing.read`.
  'contacts.read',
  'directory.export',
  'plans.read',
  'invoicing.read',
  'payments.read',
  'renewals.read',
  'broadcasts.read',
  'events.read',
  'insights.engagement',
  'insights.finance',
];

const MARKETING_KEYS: readonly PermissionKey[] = [
  'dashboard.view',
  'members.read',
  // Unenforced today — see the MANAGER_KEYS note / permission-catalogue.ts.
  'contacts.read',
  // 108 PR-D (FR-030) — marketing may switch a contact's marketing state;
  // it still holds NO `contacts.write`, so name/email/phone stay read-only.
  'contacts.marketing',
  'broadcasts.read',
  'broadcasts.write',
  'broadcasts.send',
  'events.read',
  'events.write',
  'insights.engagement',
];

export const ROLE_BUNDLES: Readonly<Record<Role, ReadonlySet<PermissionKey>>> = {
  super_admin: new Set(NON_SUPER_ADMIN_ONLY_KEYS),
  admin: new Set(NON_SUPER_ADMIN_ONLY_KEYS),
  manager: new Set(MANAGER_KEYS),
  marketing: new Set(MARKETING_KEYS),
  member: new Set<PermissionKey>(),
};

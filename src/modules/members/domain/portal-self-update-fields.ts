/**
 * FR-014a — compile-time allow-list of fields a member may self-update via
 * the `/portal` API.
 *
 * Declared as a `readonly` tuple with `as const` so the TypeScript compiler
 * refuses forged payloads at build time. The Application-layer
 * `enforceSelfServiceFieldWhitelist` use case uses this tuple as the
 * authoritative source and rejects any key not listed — emitting a
 * `member_self_update_forbidden` audit event on attempted forgery
 * (spec § Security, FR-014).
 *
 * Pure TypeScript — no framework imports.
 */

/**
 * The flag-OFF / gate = `immediate` set (F3 as shipped). Unchanged by F114 so
 * the immediate path stays byte-identical (FR-039, SC-011).
 */
export const PORTAL_SELF_UPDATE_CONTACT_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'preferredLanguage',
] as const;

export const PORTAL_SELF_UPDATE_MEMBER_FIELDS = [
  'website',
  'description',
] as const;

/**
 * F114 FR-004 (research R6) — Group A: the ONLY contact field the immediate
 * `PATCH /api/portal/profile` accepts while the gate is `approval`. It is the
 * contact's own email / notification language — a personal preference, not a
 * member-record fact — so it never becomes a change request. Every other key
 * of the flag-OFF set above is Group B while the gate is on and is refused
 * with `member_self_update_forbidden` (FR-001 closes the bypass).
 */
export const PORTAL_IMMEDIATE_CONTACT_FIELDS = ['preferredLanguage'] as const;

/** Group A has no member-level field: the display locale has its own use case. */
export const PORTAL_IMMEDIATE_MEMBER_FIELDS = [] as const;

export type PortalImmediateContactField =
  (typeof PORTAL_IMMEDIATE_CONTACT_FIELDS)[number];

export type PortalSelfUpdateContactField =
  (typeof PORTAL_SELF_UPDATE_CONTACT_FIELDS)[number];

export type PortalSelfUpdateMemberField =
  (typeof PORTAL_SELF_UPDATE_MEMBER_FIELDS)[number];

export function isPortalSelfUpdateContactField(
  value: string,
): value is PortalSelfUpdateContactField {
  return (
    PORTAL_SELF_UPDATE_CONTACT_FIELDS as readonly string[]
  ).includes(value);
}

export function isPortalSelfUpdateMemberField(
  value: string,
): value is PortalSelfUpdateMemberField {
  return (
    PORTAL_SELF_UPDATE_MEMBER_FIELDS as readonly string[]
  ).includes(value);
}

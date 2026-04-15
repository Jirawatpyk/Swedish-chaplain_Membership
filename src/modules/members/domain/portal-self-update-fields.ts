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

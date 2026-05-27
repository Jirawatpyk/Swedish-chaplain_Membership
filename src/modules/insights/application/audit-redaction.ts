/**
 * F9 US2 (T043 / FR-011) — audit-viewer payload redaction map.
 *
 * FR-011 requires payload redaction to be driven by a **defined per-event-type
 * field deny-list** so it is objectively testable rather than judgement-based.
 *
 * The US2 audit viewer is staff-only (`/admin/audit` → admin / manager; member
 * is forbidden upstream), so the projection here is admin (full) vs manager.
 * "Sensitive payload fields" per FR-011 are: (a) **internal-only annotations** —
 * override reason codes/notes, staff notes; and (b) **third-party member PII
 * values** carried in operational-event payloads (e.g. a member's email in
 * `member_invitation_sent` / `member_email_change_*`). Both are stripped from
 * the manager projection via the global deny-list below. (The member-role
 * timeline projection — US3/US6 — reuses F3's existing logic, not this map.)
 *
 * **Actor identity is NOT redacted** — `actorUserId` is a top-level audit-row
 * field (the staff member who acted), explicitly visible to admins AND managers
 * per FR-011; only `payload` fields are subject to this map.
 *
 * Design: deny-by-default for a GLOBAL set of annotation field names (so a NEW
 * event type that carries `reason`/`note`/`staff_note` is auto-redacted for the
 * manager projection even before anyone maps it), plus a per-event-type
 * extension for event-specific sensitive fields. Pure (no framework imports).
 */

/** Roles that can reach the US2 audit viewer (member is forbidden upstream). */
export type AuditViewerRole = 'admin' | 'manager';

/**
 * Annotation field NAMES treated as internal-only across every event type.
 * Stripped from the manager projection regardless of event type — the
 * deny-by-default backstop so an unmapped event can never leak an annotation.
 */
export const GLOBAL_SENSITIVE_PAYLOAD_FIELDS: readonly string[] = [
  // (a) internal-only annotations
  'reason',
  'reason_code',
  'note',
  'notes',
  'staff_note',
  'staff_notes',
  'internal_note',
  'internal_notes',
  'override_reason',
  // (b) third-party member PII values carried in operational-event payloads
  //     (PDPA §19 / GDPR Art. 5(1)(c) — a manager need not see another member's
  //     email; the structured target id already gives accountability). Deny by
  //     field NAME so any current/future event carrying one is auto-redacted.
  'email',
  'invitee_email',
  'old_email',
  'new_email',
  'contact_email',
  'recipient_email',
  'to_email',
  'phone',
  'phone_number',
];

/**
 * Event types that carry per-event sensitive payload fields beyond the global
 * deny-list. A closed union (rather than a bare `string` key) so a typo or a
 * renamed event is a COMPILE error in the map below, not a silently-disabled
 * redaction. Spans F1 (`role_changed`/`account_*`) + F2 (`fee_config_updated`)
 * + F3 (`member_*`) taxonomies — no single audit-event-type enum covers all, so
 * this union is the authoritative key space for the map.
 */
export type AuditRedactableEvent =
  | 'role_changed'
  | 'account_disabled'
  | 'account_reenabled'
  | 'fee_config_updated'
  | 'member_invitation_sent'
  | 'member_email_change_requested'
  | 'member_email_change_confirmed'
  | 'member_email_change_reverted';

/**
 * Per-event-type sensitive-field extension. Each entry lists payload field
 * names that are internal-only / third-party-PII for that event beyond the
 * global set. An event type absent here relies on the global deny-list alone.
 * Keep entries conservative — a field listed here is hidden from every manager.
 */
export const SENSITIVE_PAYLOAD_FIELDS: Readonly<
  Partial<Record<AuditRedactableEvent, readonly string[]>>
> = {
  // Role changes carry an operator justification — internal annotation.
  role_changed: ['reason'],
  // Account disable/enable justifications.
  account_disabled: ['reason'],
  account_reenabled: ['reason'],
  // F2 fiscal-config change annotations.
  fee_config_updated: ['note', 'notes'],
  // F3 member invitation / email-change events carry a third party's email.
  member_invitation_sent: ['invitee_email'],
  member_email_change_requested: ['old_email', 'new_email'],
  member_email_change_confirmed: ['old_email', 'new_email'],
  member_email_change_reverted: ['old_email', 'new_email'],
};

/**
 * Project a single audit row's `payload` for the viewing role. Returns a fresh
 * object (never mutates the input). `admin` → full payload; `manager` → payload
 * minus the global + per-event-type sensitive field names; `null` → `null`.
 */
export function redactPayloadForRole(
  eventType: string,
  payload: Record<string, unknown> | null,
  role: AuditViewerRole,
): Record<string, unknown> | null {
  if (payload === null) return null;
  if (role === 'admin') return { ...payload };

  // `eventType` is an arbitrary code; widen the union-keyed map to a string
  // index for the lookup (the union only constrains the literal's KEYS above —
  // its job is to catch a typo at definition time, not at call time).
  const perEvent =
    (SENSITIVE_PAYLOAD_FIELDS as Readonly<Record<string, readonly string[] | undefined>>)[
      eventType
    ] ?? [];
  const deny = new Set<string>([...GLOBAL_SENSITIVE_PAYLOAD_FIELDS, ...perEvent]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!deny.has(key)) out[key] = value;
  }
  return out;
}

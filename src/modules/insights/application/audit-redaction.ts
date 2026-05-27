/**
 * F9 US2 (T043 / FR-011) — audit-viewer payload redaction map.
 *
 * FR-011 requires payload redaction to be driven by a **defined per-event-type
 * field deny-list** so it is objectively testable rather than judgement-based.
 *
 * The US2 audit viewer is staff-only (`/admin/audit` → admin / manager; member
 * is forbidden upstream), so the projection here is admin (full) vs manager.
 * "Sensitive payload fields" per FR-011 are **internal-only annotations** —
 * override reason codes/notes, staff notes. (The other FR-011 category,
 * third-party-PII redaction for the member role, applies to the member timeline
 * US3/US6 and reuses F3's existing timeline projection — not this map.)
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
  'reason',
  'reason_code',
  'note',
  'notes',
  'staff_note',
  'staff_notes',
  'internal_note',
  'internal_notes',
  'override_reason',
];

/**
 * Per-event-type sensitive-field extension. Keys are `audit_event_type` values;
 * each lists payload field names that are internal-only for that event beyond
 * the global set. An event type absent here relies on the global deny-list
 * alone. Keep entries conservative — a field listed here is hidden from every
 * manager.
 */
export const SENSITIVE_PAYLOAD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Role changes carry an operator justification — internal annotation.
  role_changed: ['reason'],
  // Account disable/enable justifications.
  account_disabled: ['reason'],
  account_reenabled: ['reason'],
  // F2 fiscal-config change annotations.
  fee_config_updated: ['note', 'notes'],
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

  const deny = new Set<string>([
    ...GLOBAL_SENSITIVE_PAYLOAD_FIELDS,
    ...(SENSITIVE_PAYLOAD_FIELDS[eventType] ?? []),
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!deny.has(key)) out[key] = value;
  }
  return out;
}

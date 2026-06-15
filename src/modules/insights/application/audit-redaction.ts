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
 * `member_portal_invite_queued` / `member_contact_email_changed`). Both are
 * stripped from the manager projection via the global deny-list below. (The
 * member-role timeline projection — US3/US6 — reuses F3's existing logic.)
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
 * Event types that carry per-event sensitive payload fields BEYOND the global
 * deny-list. A closed union (rather than a bare `string` key) so a typo or a
 * renamed event is a COMPILE error in the map below, not a silently-disabled
 * redaction. Spans F1 (`role_changed`/`account_*`) + F2 (`fee_config_updated`)
 * + F3 (`member_updated`) taxonomies — no single audit-event-type enum covers
 * all, so this union is the authoritative key space for the map.
 *
 * NOTE (F9 #14): only fields NOT already in GLOBAL_SENSITIVE_PAYLOAD_FIELDS
 * belong here. The member email-change / invitation events are intentionally
 * ABSENT: the prior entries keyed event-type names that the F3 taxonomy never
 * emits (`member_invitation_sent` / `member_email_change_requested|confirmed`
 * — the live names are `member_portal_invite_queued` /
 * `member_contact_email_changed` / `member_email_change_reverted`), and their
 * fields (`invitee_email`/`old_email`/`new_email`) are already covered by the
 * global deny-list while the live events carry only pseudonymous email HASHES.
 * `member_updated` stays — its `diff` (raw old/new field VALUES) is the one
 * sensitive field the global list does not cover.
 */
export type AuditRedactableEvent =
  | 'role_changed'
  | 'account_disabled'
  | 'account_reenabled'
  | 'fee_config_updated'
  | 'member_updated';

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
  // `member_updated` carries a free-form `diff` object with old/new VALUES of
  // arbitrary member fields (taxId, notes, turnoverThb, description, …) — strip
  // the whole diff for managers (schema-agnostic: cannot drift as MemberPatch
  // grows). The `fields_changed` list + member id remain for accountability.
  // This is the only member event needing a per-event entry: its `diff` is the
  // sole sensitive field NOT already covered by the global deny-list above.
  member_updated: ['diff'],
};

/**
 * Email-like token matcher for `summary` redaction. Conservative: a run of
 * non-space/non-@ chars, `@`, then a dotted domain. Matches the F1
 * user-management summaries (`disabled manager user@x.com`).
 */
const SUMMARY_EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

/**
 * Conservative international-phone matcher (F9 #9): a leading `+`, a country
 * digit, then ≥8 more phone chars (digits / single spaces / parens / dots /
 * dashes) ending in a digit. The class uses a literal space (not `\s`) so a
 * match can never span a line break in a multi-line summary. The mandatory `+`
 * keeps this from over-redacting plain numbers that legitimately appear in
 * summaries — years, counts, ids, amounts, Thai tax IDs — none of which carry a
 * `+` prefix. `+66 81 234 5678` → `[phone redacted]`; `+5 items`, `+10.5%`,
 * `1,234,567` are untouched.
 */
const SUMMARY_PHONE_RE = /\+\d[\d ().-]{7,}\d/g;

/**
 * Redact a free-text audit `summary` for the viewing role (staff-review R001 +
 * F9 #9). `payload` redaction (above) does not cover `summary`, but F1
 * disable/create/enable-user events embed the target's **email** in the summary
 * string (`"disabled manager user@x"`), and an operational summary could embed a
 * phone number. The structured actorUserId/targetUserId already give a manager
 * accountability, so a third party's email/phone is PII a manager need not see
 * (PDPA §19 / GDPR Art. 5(1)(c)). Shared by the US2 audit viewer AND the US1
 * dashboard activity feed. `admin` → full summary; `manager` → email/phone
 * tokens replaced. (Member company names are NOT redacted here — they are within
 * a manager's member-directory read scope, so the activity feed shows them.)
 */
export function redactSummaryForRole(summary: string, role: AuditViewerRole): string {
  if (role === 'admin') return summary;
  return summary
    .replace(SUMMARY_EMAIL_RE, '[email redacted]')
    .replace(SUMMARY_PHONE_RE, '[phone redacted]');
}

/**
 * Recursively strip denied field NAMES from a payload value at ANY depth (F9 #7
 * defence-in-depth). The top-level-only projection let a nested object/array
 * carrying a denied key — e.g. `{ actor: { email: '…' } }` — leak a third
 * party's PII to the manager view AND into a member's GDPR archive. Now a denied
 * key is dropped wherever it appears. Builds fresh objects/arrays (never mutates
 * the input). Audit payloads are bounded JSON (no cycles); recursion depth =
 * the JSON nesting depth.
 */
/** A plain (JSON-shaped) object — not a Date/Map/Set/class instance. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactValueForDeny(value: unknown, deny: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValueForDeny(item, deny));
  }
  // Only recurse into PLAIN (JSON-shaped) objects. A non-plain object value —
  // Date / Map / Set / class instance — has no own enumerable JSON props, so
  // rebuilding it via Object.entries() would silently collapse it to `{}`; pass
  // it through untouched. Audit payloads are JSONB (plain) today; this hardens
  // the helper for any future in-memory caller (F9 review).
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // Skip denied keys AND `__proto__` — JSON.parse makes `__proto__` an OWN
      // enumerable prop, and `out[key] = …` on it would reparent `out` instead
      // of adding a field (prototype-pollution hardening, F9 review).
      if (key === '__proto__' || deny.has(key)) continue;
      out[key] = redactValueForDeny(inner, deny);
    }
    return out;
  }
  return value;
}

/**
 * Project a single audit row's `payload` for the viewing role. Returns a fresh
 * object (never mutates the input). `admin` → full payload; `manager` → payload
 * minus the global + per-event-type sensitive field names, stripped at ANY
 * nesting depth (F9 #7); `null` → `null`.
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
  return redactValueForDeny(payload, deny) as Record<string, unknown>;
}

/**
 * T027 — Member identity snapshot (F4).
 *
 * Copied onto the invoice at issue time so the customer block on the
 * PDF reflects the member's data as it was when the tax document was
 * issued — NOT the live data if the member subsequently updates their
 * address / legal name / tax id (FR-038).
 *
 * Boundary enforcement (architect review 2026-04-24):
 * TypeScript's type safety stops at the repo row→Domain boundary —
 * jsonb columns come back from Drizzle as `unknown`. The companion
 * `memberIdentitySnapshotSchema` is the zod runtime validator that
 * upholds this interface at every DB read; repos MUST `parse()` the
 * raw jsonb through it before handing the value to the Application
 * layer (see DrizzleInvoiceRepo). A `MalformedSnapshotError` is the
 * surfacing mechanism when DB data drifts from the Domain type.
 */
import { z } from 'zod';

export interface MemberIdentitySnapshot {
  readonly legal_name: string;
  readonly tax_id: string | null;
  readonly address: string;
  readonly primary_contact_name: string;
  readonly primary_contact_email: string;
  /**
   * 055-member-number — the buyer's human-readable per-tenant member number
   * (bare integer; the tenant prefix is a display concern resolved elsewhere).
   * `null` for: event/non-member buyers (no F3 member) AND historical
   * snapshots written before this feature (the JSONB key is absent → zod's
   * `.optional().default(null)` resolves it to null at read time). The PDF
   * template guards with `!== null`, so historical invoices skip the line
   * (SC-003 byte-identical re-render preserved).
   */
  readonly member_number: number | null;
}

/**
 * Zod runtime guard mirroring the TS interface. Non-nullable string
 * fields reject both `null` and `undefined`; `tax_id` is the only
 * nullable field. The schema is `strict()`-adjacent (we do NOT call
 * `.strict()` so future additive fields on the jsonb don't break old
 * code paths that read via this parser).
 */
export const memberIdentitySnapshotSchema = z.object({
  legal_name: z.string().min(1, 'legal_name must be a non-empty string'),
  // Thai business context: corporate members carry a 13-digit TIN;
  // individual (non-corporate) members carry `null`. An empty string
  // is rejected — callers must pick null explicitly so downstream
  // renderers (invoice PDF, tax receipt) can branch on "no TIN" vs
  // "corrupt TIN" unambiguously.
  tax_id: z
    .string()
    .min(1, 'tax_id must be null (not empty string) when absent')
    .nullable(),
  address: z.string().min(1, 'address must be a non-empty string'),
  // code-review L-03 — the buyer CONTACT is supplementary: Thai Revenue Code
  // §86/4 requires the buyer's name + address + TIN, NOT a contact. A member
  // legitimately may have no resolvable primary contact at issue time (the
  // adapter then snapshots empty strings), so an EMPTY string is accepted for
  // both contact fields. The field must still be PRESENT, though — a MISSING
  // (undefined) field is a malformed snapshot and is still rejected (the
  // original T082 guard). A NON-EMPTY email must be a valid address.
  primary_contact_name: z.string(),
  primary_contact_email: z.union([
    z.string().email('primary_contact_email, when present, must be a valid email'),
    z.literal(''),
  ]),
  // 055-member-number — additive, optional, defaults to null. `.optional()
  // .default(null)` (NOT a bare `.nullable()`) means a MISSING key parses to
  // null (historical snapshot) rather than undefined; positive int mirrors the
  // DB CHECK (member_number > 0). Declaring it here is mandatory: z.object
  // STRIPS undeclared keys, so an interface-only add silently drops the value
  // at both write and read with no type error.
  member_number: z.number().int().positive().nullable().optional().default(null),
});

export class MalformedSnapshotError extends Error {
  readonly kind = 'malformed_snapshot' as const;
  readonly invoiceId: string;
  readonly issues: readonly z.ZodIssue[];
  constructor(invoiceId: string, issues: readonly z.ZodIssue[]) {
    super(
      `Invoice ${invoiceId}: member_identity_snapshot failed schema validation at repo boundary (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    );
    this.invoiceId = invoiceId;
    this.issues = issues;
  }
}

/**
 * Thrown by `makeMemberIdentitySnapshot` when the parts fail schema
 * validation. Distinct from `MalformedSnapshotError` (the READ-boundary
 * error, which carries an `invoiceId`) — at creation time there is no
 * invoice id yet, so this surfaces the raw zod issues only.
 */
export class InvalidMemberIdentitySnapshotError extends Error {
  readonly kind = 'invalid_member_identity_snapshot' as const;
  readonly issues: readonly z.ZodIssue[];
  constructor(issues: readonly z.ZodIssue[]) {
    super(
      `member_identity_snapshot failed validation at creation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    );
    this.issues = issues;
  }
}

/**
 * Build a validated, frozen member-identity snapshot.
 *
 * code-review L-03 — validate at CREATION (defense-in-depth) so a corrupt
 * snapshot fails fast at issue / credit-note time with the exact zod issues,
 * instead of being written silently and only rejected later at the read
 * boundary (`parseMemberIdentitySnapshot` in DrizzleInvoiceRepo). On real data
 * this never throws: F3 guarantees a valid primary contact (the
 * exactly-one-primary invariant — `contacts_one_primary_per_member` partial
 * unique index + `removeContact` refusing a primary) plus a non-empty legal
 * name and a composed address.
 *
 * 055-member-number — the parameter is the schema's INPUT type, where
 * `member_number` is OPTIONAL (`.optional().default(null)`). Callers that have
 * no member number (the event/non-member draft path) may omit the key entirely
 * and the zod default supplies `null`; the returned object always carries the
 * full `MemberIdentitySnapshot` (member_number resolved). Using the input type
 * (vs the required-field interface) is what lets `create-event-invoice-draft`
 * stay a zero-change consumer.
 */
export function makeMemberIdentitySnapshot(
  parts: z.input<typeof memberIdentitySnapshotSchema>,
): MemberIdentitySnapshot {
  const result = memberIdentitySnapshotSchema.safeParse(parts);
  if (!result.success) {
    throw new InvalidMemberIdentitySnapshotError(result.error.issues);
  }
  return Object.freeze({ ...result.data });
}

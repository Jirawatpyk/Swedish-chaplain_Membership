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
   * (SC-003 byte-identical re-render preserved). The bare integer is retained
   * (additive — never removed) for backend joins / debugging; the human-facing
   * value the PDF renders is `member_number_display`.
   */
  readonly member_number: number | null;
  /**
   * 055-member-number — the FORMATTED, human-readable member number
   * (`{prefix}-{zeroPad}`, e.g. `SCCM-0042`), computed at ISSUE time from the
   * tenant's `member_number_prefix` + the bare `member_number`. Frozen on the
   * snapshot so the tax document is immutable (FR-038 / §86/4): a later prefix
   * change or member edit never alters an already-issued document — this is the
   * value the buyer block renders, consistent with the admin/portal surfaces.
   *
   * `null` for: event/non-member buyers (no F3 member) AND historical snapshots
   * written before this field shipped (the JSONB key is absent → zod's
   * `.optional().default(null)` resolves it to null at read time). The PDF
   * template guards with `!== null`, so those invoices skip the Member No. line
   * (SC-003 byte-identical re-render preserved). The bare `member_number` and
   * this display string are pinned together: both non-null for a membership
   * invoice, both null otherwise. This pairing is ENFORCED by a `.superRefine`
   * on `memberIdentitySnapshotSchema` (a half-populated snapshot fails parse at
   * both the read and write boundaries), not merely a doc convention.
   */
  readonly member_number_display: string | null;
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
  // 055-member-number — the FORMATTED display string (`{prefix}-{zeroPad}`),
  // computed at issue time and frozen here. SAME `.optional().default(null)`
  // posture as `member_number` above: a MISSING key (historical snapshot) parses
  // to null (NOT undefined) so the template omits the line and SC-003 byte-stable
  // re-render holds. Declaring it on the schema is mandatory — z.object STRIPS
  // undeclared keys, so an interface-only add would silently drop the value at
  // both write (makeMemberIdentitySnapshot) and read (repo boundary parse).
  member_number_display: z.string().min(1).nullable().optional().default(null),
}).superRefine((data, ctx) => {
  // 055-member-number — the bare integer and the formatted display string are
  // PINNED together: both null (event/non-member buyer or historical snapshot)
  // OR both non-null (membership invoice). A half-populated snapshot
  // (`member_number: 42, member_number_display: null` or vice-versa) is a
  // representable illegal state that would render an inconsistent §86/4 buyer
  // block — reject it loudly here so the READ boundary
  // (`parseMemberIdentitySnapshot` → MalformedSnapshotError) and the WRITE guard
  // (`makeMemberIdentitySnapshot` → InvalidMemberIdentitySnapshotError) both
  // refuse it instead of emitting a malformed tax document. The two
  // `.optional().default(null)` defaults run BEFORE this refine, so a missing
  // key is already resolved to null by the time the pairing is checked.
  if ((data.member_number === null) !== (data.member_number_display === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['member_number_display'],
      message:
        'member_number and member_number_display must be pinned together (both null, or both non-null)',
    });
  }
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

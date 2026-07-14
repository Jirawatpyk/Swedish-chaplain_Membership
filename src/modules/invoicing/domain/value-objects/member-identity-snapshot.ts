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
  /**
   * 088-invoice-tax-flow-redesign (§ C.1 / § F.1) — §86/4 Head-Office/Branch
   * particular for the BUYER, pinned at issue. `buyer_is_head_office=true` =
   * สำนักงานใหญ่ (default); `false` = a branch with `buyer_branch_code` carrying
   * the 5-digit code. The branch LINE is only DRAWN for a VAT-registrant
   * juristic buyer — gated on `buyer_is_vat_registrant` (populated at issue from
   * `members.legal_entity_type ≠ 'individual'` AND non-NULL; NULL/unknown →
   * false → NO line, fail-closed — NEVER `buyerHasTin`).
   *
   * OPTIONAL on the interface (wired per-story later, T030/US3): the zod schema
   * fills defaults (head-office / null / not-registrant) so a PARSED snapshot
   * always carries a value; a raw fixture / historical JSONB snapshot that omits
   * the keys reads back as the fail-closed defaults. Consumers guard `?? false`
   * / `?? true` accordingly.
   */
  readonly buyer_is_head_office?: boolean;
  readonly buyer_branch_code?: string | null;
  readonly buyer_is_vat_registrant?: boolean;
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
  // 088-invoice-tax-flow-redesign (§ C.1 / § F.1) — buyer §86/4 branch particular
  // + VAT-registrant discriminator, pinned at issue. SAME `.optional().default(…)`
  // posture as member_number (a MISSING key parses to the fail-closed default,
  // NOT undefined) — declaring them here is mandatory (z.object STRIPS undeclared
  // keys, so an interface-only add would silently drop the value at write/read).
  buyer_is_head_office: z.boolean().optional().default(true),
  buyer_branch_code: z
    .string()
    .regex(/^\d{5}$/, 'buyer_branch_code must be 5 digits')
    .nullable()
    .optional()
    .default(null),
  buyer_is_vat_registrant: z.boolean().optional().default(false),
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
  // 088-invoice-tax-flow-redesign (§ C.1) — buyer_is_head_office ⇔ branch_code
  // are pinned: head-office ⇒ code MUST be null; branch ⇒ code MUST be a 5-digit
  // string. Both defaults run BEFORE this refine, so a snapshot omitting the keys
  // resolves to head-office / null and passes. A half-populated pair is a
  // representable illegal state → reject it at both the read and write boundary.
  if (data.buyer_is_head_office && data.buyer_branch_code !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buyer_branch_code'],
      message: 'head-office buyer must have a null branch_code',
    });
  }
  if (!data.buyer_is_head_office && data.buyer_branch_code === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buyer_branch_code'],
      message: 'branch buyer must carry a 5-digit branch_code',
    });
  }
  // NOTE — the `registrant ⇒ TIN` invariant (059 / PR-A Task 4) is DELIBERATELY
  // NOT here. It is a WRITE-time rule, enforced in `makeMemberIdentitySnapshot`
  // below. See the comment there: this schema is also the READ boundary, and a
  // rule that governs what we may CREATE must never make what we ALREADY WROTE
  // unreadable.
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

  // 059 / PR-A Task 4 — ประกาศอธิบดีฯ 196 (buyer TIN) + 199 (สำนักงานใหญ่ /
  // สาขา) are a PAIR: both are mandatory when the buyer is a VAT registrant. A
  // snapshot with the flag set and no TIN would print the branch line with no
  // taxpayer number — a defective §86/4 document. This is the last gate before
  // an immutable tax document exists (create-member's and update-member's own
  // guards are UX that surface the problem earlier), so it fails LOUD.
  //
  // IT LIVES HERE, ON THE WRITE PATH — NOT IN THE SCHEMA'S superRefine ABOVE.
  //
  // `memberIdentitySnapshotSchema` is ALSO the READ boundary: DrizzleInvoiceRepo's
  // `parseMemberIdentitySnapshot` runs it over the frozen JSONB of every invoice
  // row it loads, and `list()` / `listPaged()` map rows without a per-row guard.
  // A rule placed in the shared schema is therefore retroactive: any document
  // ISSUED under the old rules that violates the NEW one becomes unparseable, and
  // a single such row takes down the whole invoice list page — an unhandled 500,
  // no error code, no audit trail. That is precisely the class of silent failure
  // this branch exists to remove, and it would have been reintroduced by the
  // branch's own new rule.
  //
  // The principle is the same one the templateVersion gate encodes for RENDERING:
  // a document already issued must remain readable and reproducible forever. A
  // constraint on what we may CREATE must never invalidate what we already WROTE.
  // If a historical snapshot needs correcting, that is a credit note (§86/10) —
  // not a parse error on someone's invoice list.
  if (result.data.buyer_is_vat_registrant === true && result.data.tax_id === null) {
    throw new InvalidMemberIdentitySnapshotError([
      {
        code: z.ZodIssueCode.custom,
        path: ['tax_id'],
        message:
          'a VAT-registrant buyer must carry a tax_id (ประกาศอธิบดีฯ 196 + 199)',
      },
    ]);
  }

  return Object.freeze({ ...result.data });
}

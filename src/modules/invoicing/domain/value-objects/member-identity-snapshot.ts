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
  primary_contact_name: z
    .string()
    .min(1, 'primary_contact_name must be a non-empty string'),
  primary_contact_email: z
    .string()
    .email('primary_contact_email must be a valid email'),
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

export function makeMemberIdentitySnapshot(parts: MemberIdentitySnapshot): MemberIdentitySnapshot {
  return Object.freeze({ ...parts });
}

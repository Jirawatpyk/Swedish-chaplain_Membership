/**
 * F114 FR-006 / research R14 + § V1 — ONE rule set for every Group B field.
 *
 * "Proposed values MUST pass the validation that applies to a staff edit of
 * the same field." The canonical rule is the SERVER staff-edit schema
 * (`updateMemberSchema` in update-member.ts, `updateContactFieldsSchema` in
 * contact-crud.ts). Those schemas build their Group B entries FROM the
 * objects exported here, and `tests/unit/members/change-requests/
 * field-rules-parity.test.ts` asserts reference equality per key — so the
 * member path and the staff path literally share one zod object and cannot
 * drift (the divergence the spec-review panel measured on `website` is
 * exactly what two hand-copied rules produce).
 *
 * Phone: the staff path applies `asPhone` (E.164) after zod; `validateProposal`
 * applies the same value object.
 *
 * zod is a validation library, not a framework — the Domain layer already
 * uses it (plans `plan-validators.ts`, invoicing `member-identity-snapshot.ts`).
 * `@/lib/safe-url` and `@/lib/result` are pure TypeScript.
 */
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { hasDangerousUrlScheme } from '@/lib/safe-url';
import { asPhone } from '../value-objects/phone';
import type { GroupBCompanyFields, GroupBContactFields, GroupBProposal } from './policies';
import {
  BILLING_ADDRESS_LINES,
  REGISTERED_ADDRESS_LINES,
  type BillingAddress,
  type RegisteredAddress,
} from './proposable-fields';

// ---------------------------------------------------------------------------
// The shared rule objects (identity matters — see the parity test)
// ---------------------------------------------------------------------------

/**
 * Normalises a bare domain ("facebook.com/x") into a full URL by prefixing
 * `https://` ahead of the `.url()` check. Moved here from the staff member
 * form so the portal change-request form and `validateProposal` apply the same
 * courtesy the staff form applies. A non-string / blank value is left alone.
 */
/**
 * E.164 form of an accepted phone; a value `asPhone` cannot parse is
 * returned UNCHANGED (never null, never invented) — `validateProposal`'s
 * superRefine has already refused it, so this arm is the helper's own
 * fail-safe contract, pinned directly in field-rules-parity.test.ts.
 */
export function normalisePhoneValue(value: string): string {
  const phone = asPhone(value);
  return phone.ok ? phone.value : value;
}

export function normalizeWebsiteUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '' || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export const MEMBER_FIELD_RULES = {
  company_name: z.string().trim().min(1).max(200).optional(),
  // `.url()` accepts javascript:/data:; block hostile schemes since this is
  // rendered as an <a href> on the member-detail page (safe-url.ts sink is
  // the guarantee, this is the early boundary error).
  website: z
    .string()
    .max(200)
    .url()
    .refine((v) => !hasDangerousUrlScheme(v), { message: 'website scheme not allowed' })
    .nullable()
    .optional()
    .or(z.literal('')),
  description: z.string().max(2000).nullable().optional(),
} as const;

export const REGISTERED_ADDRESS_LINE_RULES = {
  line1: z.string().max(200).nullable().optional(),
  line2: z.string().max(200).nullable().optional(),
  sub_district: z.string().max(100).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  province: z.string().max(100).nullable().optional(),
  postal_code: z.string().max(20).nullable().optional(),
} as const;

export const BILLING_ADDRESS_LINE_RULES = {
  line1: z.string().max(200).nullable().optional(),
  line2: z.string().max(200).nullable().optional(),
  sub_district: z.string().max(100).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  province: z.string().max(100).nullable().optional(),
  postal_code: z.string().max(20).nullable().optional(),
  country: z.string().length(2).nullable().optional(),
} as const;

export const CONTACT_FIELD_RULES = {
  first_name: z.string().trim().min(1).max(100).optional(),
  last_name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().max(20).nullable().optional(),
  role_title: z.string().max(100).nullable().optional(),
} as const;

// ---------------------------------------------------------------------------
// The proposal schema (member side) — strict at every level
// ---------------------------------------------------------------------------

// The phone E.164 rule (`asPhone`, what the staff path applies after zod) runs
// as a refinement on the contact object so its issue is COLLECTED alongside
// every other field-level issue in one pass — a member fixing three fields
// must see all three errors at once, not one per round-trip.
const contactProposalSchema = z
  .object(CONTACT_FIELD_RULES)
  .strict()
  .superRefine((c, ctx) => {
    if (typeof c.phone === 'string') {
      const phone = asPhone(c.phone);
      if (!phone.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phone'],
          message: `invalid phone: ${phone.error.code}`,
        });
      }
    }
  });
const registeredAddressSchema = z.object(REGISTERED_ADDRESS_LINE_RULES).strict();
/**
 * The billing group is ONE unit (member-billing-address 0284,
 * `members_billing_address_group_ck`): any line present ⇒ line1 + city +
 * postal_code + country present. The staff path enforces the same rule in
 * `update-member.ts` against the resulting row; here it runs at the proposal
 * boundary so an incomplete group is refused with field-level issues at
 * SUBMIT instead of the DB refusing it at APPROVE (review: tax I-2).
 */
export const BILLING_GROUP_REQUIRED_LINES = ['line1', 'city', 'postal_code', 'country'] as const;
const billingAddressSchema = z
  .object(BILLING_ADDRESS_LINE_RULES)
  .strict()
  .superRefine((group, ctx) => {
    const present = (v: unknown) => typeof v === 'string' && v.trim() !== '';
    const anyPresent = BILLING_ADDRESS_LINES.some((line) => present(group[line]));
    if (!anyPresent) return;
    for (const line of BILLING_GROUP_REQUIRED_LINES) {
      if (!present(group[line])) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [line], message: 'billing_address_incomplete' });
      }
    }
  });
const companyProposalSchema = z
  .object({
    company_name: MEMBER_FIELD_RULES.company_name,
    website: z.preprocess(normalizeWebsiteUrl, MEMBER_FIELD_RULES.website),
    description: MEMBER_FIELD_RULES.description,
    registered_address: registeredAddressSchema.optional(),
    billing_address: billingAddressSchema.optional(),
  })
  .strict();

export const proposalSchema = z
  .object({
    contact: contactProposalSchema.optional(),
    company: companyProposalSchema.optional(),
  })
  .strict();

export type ProposalInput = z.input<typeof proposalSchema>;

function fillLines<L extends string>(
  lines: readonly L[],
  value: Partial<Record<L, string | null | undefined>>,
): Record<L, string | null> {
  const out = {} as Record<L, string | null>;
  // '' is an EMPTY line (the DB group CHECK and the staff rule both reason in
  // NULLs) — never store a blank string that the CHECK then counts as present
  for (const line of lines) {
    const v = value[line];
    out[line] = typeof v === 'string' && v.trim() === '' ? null : (v ?? null);
  }
  return out;
}

/**
 * Validates a raw proposal against the staff rules and normalises it:
 * trims where the staff rule trims, `''` website → `null` (clear), phone
 * through `asPhone` (E.164), address groups filled to every line (a missing
 * line is `null` — a group is one unit; the client sends the whole object).
 *
 * Issues use zod paths (`contact.phone`, `company.billing_address.country`)
 * so the route can map them back to form fields.
 */
export function validateProposal(raw: unknown): Result<GroupBProposal, z.ZodIssue[]> {
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) return err(parsed.error.issues);
  const out: { contact?: Partial<GroupBContactFields>; company?: Partial<GroupBCompanyFields> } = {};

  if (parsed.data.contact !== undefined) {
    const c = parsed.data.contact;
    const contact: Partial<Record<'first_name' | 'last_name' | 'phone' | 'role_title', string | null>> = {};
    if (c.first_name !== undefined) contact.first_name = c.first_name;
    if (c.last_name !== undefined) contact.last_name = c.last_name;
    if (c.role_title !== undefined) contact.role_title = c.role_title;
    if (c.phone !== undefined) {
      // The superRefine above already refused a malformed value; the
      // normaliser here only NORMALISES the accepted one ("+66 81-234-5678"
      // → E.164) and never invents a value.
      contact.phone = c.phone === null ? null : normalisePhoneValue(c.phone);
    }
    out.contact = contact;
  }

  if (parsed.data.company !== undefined) {
    const c = parsed.data.company;
    const company: {
      company_name?: string;
      website?: string | null;
      description?: string | null;
      registered_address?: RegisteredAddress;
      billing_address?: BillingAddress;
    } = {};
    if (c.company_name !== undefined) company.company_name = c.company_name;
    if (c.website !== undefined) company.website = c.website === '' ? null : c.website;
    if (c.description !== undefined) company.description = c.description;
    if (c.registered_address !== undefined) {
      company.registered_address = fillLines(REGISTERED_ADDRESS_LINES, c.registered_address);
    }
    if (c.billing_address !== undefined) {
      company.billing_address = fillLines(BILLING_ADDRESS_LINES, c.billing_address);
    }

    out.company = company;
  }

  return ok(out);
}

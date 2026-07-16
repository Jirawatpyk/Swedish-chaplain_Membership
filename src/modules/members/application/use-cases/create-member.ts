/**
 * `create-member` use case (T044, US1 FR-002).
 *
 * Admin creates a new member + primary contact + audit trail in ONE
 * DB transaction via `MemberRepo.createWithPrimaryContact`. Zod validates
 * the wire payload; Domain value objects re-validate at the branded-type
 * boundary (defence in depth).
 *
 * Soft-duplicate detection (FR-031) runs BEFORE the insert — if a member
 * with the same (tenant, company_name, country) already exists, the caller
 * must confirm via `confirm_soft_duplicate: true`. This keeps the human
 * in the loop without forcing a hard-uniqueness constraint that would
 * block legitimate franchisees / subsidiaries.
 *
 * Plan-aware validation (turnover / age / startup) reads plan bounds via
 * `PlanLookupPort` (stubbed permissive in B.1) and returns a `validation_*`
 * error unless the client included an `override_reason` with the expected
 * shape per FR-006a.
 *
 * Pure Application logic — no Drizzle / Next / React imports.
 */

import { z } from 'zod';
import { hasDangerousUrlScheme } from '@/lib/safe-url';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { asEmail } from '../../domain/value-objects/email';
import { asPhone, type Phone } from '../../domain/value-objects/phone';
import { asIsoCountryCode } from '../../domain/value-objects/iso-country-code';
import { asTaxId, type TaxId } from '../../domain/value-objects/tax-id';
// Review fix (Finding 1) — close `legal_entity_type` to the 12-code
// catalogue at THIS boundary too. Task 3b closed it client-side only
// (the admin form's Select), so a direct API caller could still store an
// arbitrary string — defeating the whole point (the fail-soft label
// resolver would then print raw snake_case on the member page).
import { LEGAL_ENTITY_TYPES } from '../../domain/value-objects/legal-entity-type';
import {
  asOverrideReason,
  OVERRIDE_REASON_CODES,
} from '../../domain/value-objects/override-reason';
import { checkTurnoverBand } from '../../domain/policies/turnover-policy';
import { checkAgeEligibility } from '../../domain/policies/age-eligibility-policy';
import { checkStartupDuration } from '../../domain/policies/startup-duration-policy';
import { asPlanId, BILLING_CYCLES } from '../../domain/member';
import type { Member, MemberId } from '../../domain/member';
import type { Contact, ContactId } from '../../domain/contact';
import type {
  MemberRepo,
  RepoConflictReason,
  RepoError,
} from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { PlanLookupPort } from '../ports/plan-lookup-port';
import type { MemberNumberAllocatorPort } from '../ports/member-number-allocator-port';
import { UseCaseAbort } from '../tx-abort';

// --- Input schema ------------------------------------------------------------

export const createMemberSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  // Review fix (Finding 1) — closed to the 12-code catalogue, mirroring the
  // client's own `buildMemberFormSchema` (schema.ts). Must accept a valid
  // code, `null`, AND "unset" (`undefined` / `''`) — 10 of TSCC's 150
  // members have no recorded type, and rejecting unset would make a
  // create with every other field valid fail on this one alone.
  legal_entity_type: z.enum(LEGAL_ENTITY_TYPES).nullable().optional().or(z.literal('')),
  country: z.string().length(2),
  tax_id: z.string().max(50).nullable().optional(),
  // 059 / PR-A — the §86/4 VAT-registrant flag, RECORDED not derived. Default
  // false when omitted (never inferred from legal_entity_type).
  is_vat_registered: z.boolean().optional(),
  // 065 §5.1 — per-member billing cadence (calendar-year vs rolling
  // anniversary), RECORDED not derived. Optional here with a 'rolling' default
  // at the mapping below — EXACT parity with is_vat_registered above: a direct
  // API caller that omits it takes the DB DEFAULT ('rolling'). The admin FORM
  // makes it a REQUIRED free choice (client zod has no default / no '' arm);
  // this lenient server default only backstops a direct caller and keeps the
  // ~19 inline-payload create integration tests green.
  billing_cycle: z.enum(BILLING_CYCLES).optional(),
  // `.url()` alone accepts javascript:/data: (any scheme new URL() parses),
  // and this value is later rendered as an <a href>; block hostile schemes.
  // See src/lib/safe-url.ts (render sink safeExternalHref is the guarantee).
  website: z
    .string()
    .max(200)
    .url()
    .refine((v) => !hasDangerousUrlScheme(v), { message: 'website scheme not allowed' })
    .nullable()
    .optional(),
  description: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  address_line1: z.string().max(200).nullable().optional(),
  address_line2: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  province: z.string().max(100).nullable().optional(),
  postal_code: z.string().max(20).nullable().optional(),
  sub_district: z.string().max(100).nullable().optional(),
  founded_year: z.number().int().min(1800).max(2100).nullable().optional(),
  turnover_thb: z.number().int().nonnegative().nullable().optional(),
  registered_capital_thb: z.number().int().nonnegative().nullable().optional(),
  plan_id: z.string().min(1),
  plan_year: z.number().int().min(2020).max(2100),
  registration_date: z.string().optional(), // ISO date; defaults to today
  primary_contact: z.object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    email: z.string().max(254),
    phone: z.string().max(20).nullable().optional(),
    role_title: z.string().max(100).nullable().optional(),
    preferred_language: z.enum(['en', 'th', 'sv']),
    date_of_birth: z.string().nullable().optional(),
  }),
  // PR-B task 8 — optional secondary contact. Same shape as primary_contact
  // MINUS date_of_birth (that gate is primary-only and plan-driven — the
  // Thai Alumni DOB requirement never applies to a secondary contact).
  secondary_contact: z
    .object({
      first_name: z.string().trim().min(1).max(100),
      last_name: z.string().trim().min(1).max(100),
      email: z.string().max(254),
      phone: z.string().max(20).nullable().optional(),
      role_title: z.string().max(100).nullable().optional(),
      preferred_language: z.enum(['en', 'th', 'sv']),
      // Task 8 (GDPR Art. 14) — a secondary contact's data is supplied by
      // the admin, not by the person themselves (a third party). The admin
      // must attest they informed that person before this write proceeds.
      // `z.literal(true)` (not `z.boolean()`) so `false`/`undefined`/any
      // other value fails validation — server-side enforcement so a direct
      // API call cannot skip the UI checkbox.
      art14_attested: z.literal(true),
    })
    .optional(),
  override_reason_code: z.enum(OVERRIDE_REASON_CODES).nullable().optional(),
  override_reason_note: z.string().max(500).nullable().optional(),
  confirm_soft_duplicate: z.boolean().optional(),
}).superRefine((data, ctx) => {
  // 059 / PR-A Task 4 — registrant ⇒ TIN invariant (ประกาศอธิบดีฯ 196 + 199
  // are a PAIR): a member created as a VAT registrant must also carry a
  // tax_id, or the §86/4 buyer block on a future tax document would print
  // the branch line with no taxpayer number. CREATE supplies the full
  // record in one request (unlike updateMemberSchema's PARTIAL patch, where
  // this same rule has to live in the use-case body instead — see
  // update-member.ts), so it fits cleanly on the schema here. The Domain
  // value-object (member-identity-snapshot.ts) is the last, load-bearing
  // gate at issue time; this is UX that surfaces the problem at create time.
  if (data.is_vat_registered === true && !data.tax_id?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tax_id'],
      message: 'a VAT-registrant member must have a tax_id',
    });
  }
});

export type CreateMemberInput = z.infer<typeof createMemberSchema>;

// --- Errors ------------------------------------------------------------------

export type CreateMemberError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'invalid_email' }
  | { type: 'invalid_phone' }
  // PR-B task 8 — secondary contact validation branches. Kept as their own
  // discriminated types (not reusing invalid_email/invalid_phone) so the
  // route can put a distinct `details.type` on the 400 response and
  // `mapMemberCreateServerError` can route the highlight to
  // `secondary_contact.email` / `secondary_contact.phone` instead of the
  // primary fields.
  | { type: 'invalid_secondary_email' }
  | { type: 'invalid_secondary_phone' }
  // Cheap guard for the commonest secondary-contact conflict, checked
  // BEFORE any DB write — the client zod schema blocks this first, this is
  // defense-in-depth for a direct API call.
  | { type: 'secondary_email_same_as_primary' }
  | { type: 'invalid_country' }
  | { type: 'invalid_tax_id'; code: string }
  | { type: 'invalid_override_reason'; code: string }
  | { type: 'plan_not_found' }
  | {
      type: 'turnover_out_of_band';
      turnoverThb: number;
      band: { minThb: number | null; maxThb: number | null };
    }
  | {
      type: 'age_not_eligible';
      ageYears: number;
      maxAge: number;
    }
  | { type: 'startup_too_old'; foundedYear: number; maxAllowedYears: number }
  | {
      type: 'soft_duplicate';
      existingMemberId: string;
      existingCompanyName: string;
    }
  | { type: 'conflict'; reason: RepoConflictReason }
  | { type: 'audit_failed' }
  | { type: 'server_error'; message: string };

// --- Onboarding listeners (F8-completion Slice 1 · Task 1.6) -----------------

/**
 * Event handed to each `onboardingListeners` callback POST-COMMIT, after
 * the create tx (member + contact + audit) has committed durably. F8's
 * `f8OnCreateMemberCallbacks(tenantId)` factory consumes this to create
 * the new member's initial renewal cycle (anchored at `registrationDate`).
 *
 * `registrationDate` is an ISO 8601 UTC string (the cycle's `period_from`
 * anchor). `correlationId` is the request id for log+trace correlation.
 */
export type CreateMemberListenerEvent = {
  readonly tenantId: string;
  readonly memberId: string;
  /** ISO 8601 UTC — the member's registration_date, the cycle anchor. */
  readonly registrationDate: string;
  readonly planId: string;
  readonly correlationId: string;
};

export type CreateMemberListener = (
  evt: CreateMemberListenerEvent,
) => Promise<void>;

// --- Deps --------------------------------------------------------------------

export type CreateMemberDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  plans: PlanLookupPort;
  audit: AuditPort;
  clock: ClockPort;
  /**
   * Allocates the next per-tenant human-readable member number INSIDE the
   * createMember runInTenant(tx) lambda (under the tenant RLS session).
   * Must run BEFORE createWithPrimaryContactInTx — the allocated integer is
   * threaded into the member INSERT in the SAME tx (gap-OK on rollback).
   */
  memberNumberAllocator: MemberNumberAllocatorPort;
  idFactory: {
    memberId(): MemberId;
    contactId(): ContactId;
  };
  /**
   * F8-completion Slice 1 · Task 1.6 — post-commit best-effort listeners
   * (e.g. create the member's initial renewal cycle). Mirror change-plan's
   * `manualPlanChangeListeners`: each runs in its OWN tenant tx (the
   * listener opens it), and failures are logged + counted
   * (`renewalsMetrics.bootstrapCycleCreateFailed`) and NEVER roll back the
   * already-committed member create — there is no tx to roll back and no
   * webhook retry to heal it (the only swallow site in F8-completion).
   * Optional — when undefined, createMember is unchanged. F8's
   * `f8OnCreateMemberCallbacks(tenant.slug)` factory supplies the canonical
   * single listener.
   */
  onboardingListeners?: ReadonlyArray<CreateMemberListener>;
};

export type CreateMemberCallMeta = {
  actorUserId: string;
  requestId: string;
};

// --- Implementation ----------------------------------------------------------

export async function createMember(
  input: unknown,
  meta: CreateMemberCallMeta,
  deps: CreateMemberDeps,
): Promise<
  Result<{ memberId: MemberId; contactId: ContactId }, CreateMemberError>
> {
  // 1. zod shape + integrity
  const parsed = createMemberSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const data = parsed.data;

  // 2. Domain value-object validation
  const country = asIsoCountryCode(data.country);
  if (!country.ok) return err({ type: 'invalid_country' });

  const email = asEmail(data.primary_contact.email);
  if (!email.ok) return err({ type: 'invalid_email' });

  let phone: Phone | null = null;
  if (data.primary_contact.phone) {
    const r = asPhone(data.primary_contact.phone);
    if (!r.ok) return err({ type: 'invalid_phone' });
    phone = r.value;
  }

  // PR-B task 8 — optional secondary contact. Validated the same way as the
  // primary contact, plus a same-email guard: the client zod schema blocks
  // this first (cheap, before any round-trip), this is defense-in-depth for
  // a caller that bypasses the form (direct API call). The draft is
  // assembled here (not later, alongside contactDraft) so `secondaryEmail`'s
  // non-null-ness stays in ONE block instead of relying on a re-check of
  // `data.secondary_contact` to satisfy the type checker further down.
  let secondaryContactDraft:
    | Omit<Contact, 'createdAt' | 'updatedAt' | 'memberId'>
    | null = null;
  if (data.secondary_contact) {
    const secondaryEmailResult = asEmail(data.secondary_contact.email);
    if (!secondaryEmailResult.ok) return err({ type: 'invalid_secondary_email' });
    const secondaryEmail = secondaryEmailResult.value;

    // asEmail() normalises to lowercase (see email.ts), so a plain `===`
    // is a correct case-insensitive comparison.
    if (secondaryEmail === email.value) {
      return err({ type: 'secondary_email_same_as_primary' });
    }

    let secondaryPhone: Phone | null = null;
    if (data.secondary_contact.phone) {
      const r = asPhone(data.secondary_contact.phone);
      if (!r.ok) return err({ type: 'invalid_secondary_phone' });
      secondaryPhone = r.value;
    }

    secondaryContactDraft = {
      tenantId: deps.tenant.slug,
      contactId: deps.idFactory.contactId(),
      firstName: data.secondary_contact.first_name.trim(),
      lastName: data.secondary_contact.last_name.trim(),
      email: secondaryEmail,
      phone: secondaryPhone,
      roleTitle: data.secondary_contact.role_title ?? null,
      preferredLanguage: data.secondary_contact.preferred_language,
      isPrimary: false,
      // No DOB collection on the secondary contact (primary-only gate).
      dateOfBirth: null,
      linkedUserId: null,
      inviteBouncedAt: null,
      // Task 8 — the zod `art14_attested: z.literal(true)` gate above has
      // already refused this request unless the admin attested. `clock.now()`
      // (not a bare `new Date()`) for consistency with `regDate` below and so
      // a fake clock in tests observes a deterministic attestation moment.
      art14AttestedAt: deps.clock.now(),
      removedAt: null,
    };
  }

  let taxId: TaxId | null = null;
  if (data.tax_id) {
    const r = asTaxId(data.tax_id, country.value);
    if (!r.ok) return err({ type: 'invalid_tax_id', code: r.error.code });
    taxId = r.value;
  }

  // 3. Override reason (present iff admin is bypassing a warning)
  if (data.override_reason_code) {
    const r = asOverrideReason(
      data.override_reason_code,
      data.override_reason_note ?? null,
    );
    if (!r.ok)
      return err({ type: 'invalid_override_reason', code: r.error.code });
  }
  const overrideAsserted = Boolean(data.override_reason_code);

  // 4. Plan-aware validation via PlanLookupPort.
  // asPlanId() brands the raw input; getPlan validates existence.
  const planResult = await deps.plans.getPlan(
    deps.tenant,
    asPlanId(data.plan_id),
    data.plan_year,
  );
  if (!planResult.ok) return err({ type: 'plan_not_found' });
  const plan = planResult.value;
  // code-review #9-#14 follow-up — `getPlan`/`findOne` deliberately returns
  // soft-deleted plans, so a `planResult.ok` plan may still be soft-deleted.
  // A member must never be created onto a soft-deleted plan (the same
  // integrity rule changePlan enforces, W0-02 #1). Reuse `plan_not_found` so
  // the create path is consistent with the change path.
  if (plan.isSoftDeleted) return err({ type: 'plan_not_found' });

  const regDate = data.registration_date
    ? new Date(data.registration_date)
    : deps.clock.now();

  // turnover band
  const turnoverResult = checkTurnoverBand(data.turnover_thb ?? null, {
    minThb: plan.minTurnoverThb,
    maxThb: plan.maxTurnoverThb,
  });
  if (!turnoverResult.ok && !overrideAsserted) {
    return err({
      type: 'turnover_out_of_band',
      turnoverThb: turnoverResult.error.turnoverThb,
      band: turnoverResult.error.band,
    });
  }

  // startup duration (only if plan has a max_duration_years)
  if (plan.maxDurationYears !== null && data.founded_year !== null && data.founded_year !== undefined) {
    const s = checkStartupDuration(
      data.founded_year,
      regDate,
      plan.maxDurationYears,
    );
    if (!s.ok && !overrideAsserted) {
      return err({
        type: 'startup_too_old',
        foundedYear: s.error.foundedYear,
        maxAllowedYears: s.error.maxAllowedYears,
      });
    }
  }

  // age eligibility (only if plan has a max_member_age and DOB present)
  if (
    plan.maxMemberAge !== null &&
    data.primary_contact.date_of_birth
  ) {
    const dob = new Date(data.primary_contact.date_of_birth);
    const a = checkAgeEligibility(dob, regDate, plan.maxMemberAge);
    if (!a.ok && !overrideAsserted) {
      return err({
        type: 'age_not_eligible',
        ageYears: a.error.ageYears,
        maxAge: a.error.maxAge,
      });
    }
  }

  // 5. Soft-duplicate detection (FR-031)
  const dup = await deps.memberRepo.findSoftDuplicate(
    deps.tenant,
    data.company_name.trim(),
    country.value,
  );
  if (!dup.ok) {
    return err({
      type: 'server_error',
      message: `soft-dup: ${dup.error.code}`,
    });
  }
  if (dup.value !== null && !data.confirm_soft_duplicate) {
    return err({
      type: 'soft_duplicate',
      existingMemberId: dup.value.memberId,
      existingCompanyName: dup.value.companyName,
    });
  }

  // 6. Assemble identity + persist. The member number is allocated INSIDE
  // the tenant tx (first statement) so the per-tenant counter bump and the
  // member INSERT commit/rollback atomically (gap-OK: a rolled-back create
  // leaves the counter incremented — numbers are never reused).
  const memberId = deps.idFactory.memberId();
  const contactId = deps.idFactory.contactId();
  const contactDraft: Omit<Contact, 'createdAt' | 'updatedAt' | 'memberId'> = {
    tenantId: deps.tenant.slug,
    contactId,
    firstName: data.primary_contact.first_name.trim(),
    lastName: data.primary_contact.last_name.trim(),
    email: email.value,
    phone,
    roleTitle: data.primary_contact.role_title ?? null,
    preferredLanguage: data.primary_contact.preferred_language,
    isPrimary: true,
    dateOfBirth: data.primary_contact.date_of_birth
      ? new Date(data.primary_contact.date_of_birth)
      : null,
    linkedUserId: null,
    inviteBouncedAt: null,
    // Task 8 — the primary contact is a first-party relationship (the
    // member supplied their own representative's details), so GDPR Art. 14
    // does not apply. Always NULL — never re-derive this from `isPrimary`
    // elsewhere; see `Contact.art14AttestedAt` (domain/contact.ts).
    art14AttestedAt: null,
    removedAt: null,
  };

  // W1: throw-to-rollback — number allocation + state + audit rows atomic.
  try {
    const created = await runInTenant(deps.tenant, async (tx) => {
      // FIRST statement: allocate under the tenant RLS session. Running this
      // outside the tx would use a pool-fresh connection without
      // SET LOCAL app.current_tenant → silent RLS bypass (F7.1a US2 class).
      const memberNumber = await deps.memberNumberAllocator.allocate(
        tx,
        deps.tenant.slug,
      );

      const memberDraft: Omit<Member, 'createdAt' | 'updatedAt'> = {
        tenantId: deps.tenant.slug,
        memberId,
        memberNumber,
        companyName: data.company_name.trim(),
        // Collapses '' (the client Select's "nothing picked" sentinel) and
        // `undefined` to `null` — every falsy branch of the zod union means
        // "unset"; every LEGAL_ENTITY_TYPES code is a non-empty string, so
        // `||` correctly narrows the type to LegalEntityTypeCode | null.
        legalEntityType: data.legal_entity_type || null,
        country: country.value,
        taxId,
        isVatRegistered: data.is_vat_registered ?? false,
        // 065 §5.1 — per-member billing cadence. `?? 'rolling'` mirrors the
        // is_vat_registered `?? false` above (the DB DEFAULT for this column
        // is 'rolling'); the admin form always threads the chosen value.
        billingCycle: data.billing_cycle ?? 'rolling',
        website: data.website ?? null,
        description: data.description ?? null,
        foundedYear: data.founded_year ?? null,
        turnoverThb: data.turnover_thb ?? null,
        registeredCapitalThb: data.registered_capital_thb ?? null,
        planId: plan.planId,
        planYear: data.plan_year,
        registrationDate: regDate,
        registrationFeePaid: false,
        lastActivityAt: null,
        notes: data.notes ?? null,
        addressLine1: data.address_line1 ?? null,
        addressLine2: data.address_line2 ?? null,
        city: data.city ?? null,
        province: data.province ?? null,
        postalCode: data.postal_code ?? null,
        subDistrict: data.sub_district ?? null,
        status: 'active',
        archivedAt: null,
      };

      const result = await deps.memberRepo.createWithPrimaryContactInTx(tx, {
        member: memberDraft,
        primaryContact: contactDraft,
        // PR-B task 8 — inserted in the SAME transaction as the member +
        // primary contact (never a separate call): a secondary-email
        // collision must roll back the whole create, not leave an orphan
        // member/primary-contact row.
        ...(secondaryContactDraft && { secondaryContact: secondaryContactDraft }),
      });
      if (!result.ok) throw new UseCaseAbort<RepoError>(result.error);

      const memberAudit = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_created',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `member_created ${result.value.member.companyName}`,
        payload: {
          member_id: result.value.member.memberId,
          company_name: result.value.member.companyName,
          plan_id: result.value.member.planId,
          plan_year: result.value.member.planYear,
          primary_contact_id: result.value.contact.contactId,
          // FR-006a — persist the override reason on the ORIGINATING audit
          // event (member_created) so F9 can aggregate overrides by reason
          // code. Present only when an override was asserted to bypass a
          // turnover/start-up/age warning (validated at ~:225). Mirrors the
          // change-plan.ts pattern; keeps the note as null when omitted.
          ...(data.override_reason_code && {
            override_reason_code: data.override_reason_code,
            override_reason_note: data.override_reason_note ?? null,
          }),
        },
      });
      if (!memberAudit.ok) throw new UseCaseAbort<RepoError>(memberAudit.error);

      // 055-member-number — record the allocated human-readable number
      // adjacent to member_created. snake_case `member_id` keeps the member
      // rising in the directory's last-activity sort (the denorm trigger
      // fires only on payload ? 'member_id'; schema-members.ts:75-79).
      const numberAudit = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_number_assigned',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        // The bare number is intentionally NOT interpolated into the free-text
        // summary: `redactSummaryForRole` (audit viewer + GDPR subset) only
        // strips emails, so a number here would leak past the logger's
        // `member_number` REDACT_PATHS. The value lives in the structured
        // `payload` below, which is access-controlled — the canonical place.
        summary: 'member_number_assigned',
        payload: {
          member_id: result.value.member.memberId,
          member_number: memberNumber,
        },
      });
      if (!numberAudit.ok) throw new UseCaseAbort<RepoError>(numberAudit.error);

      const contactAudit = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'contact_created',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `contact_created for member ${result.value.member.memberId}`,
        payload: {
          member_id: result.value.member.memberId,
          contact_id: result.value.contact.contactId,
          is_primary: true,
        },
      });
      if (!contactAudit.ok) throw new UseCaseAbort<RepoError>(contactAudit.error);

      // PR-B task 8 — a SECOND contact_created audit event, in the SAME tx,
      // when a secondary contact was added. No new audit event type — the
      // existing `contact_created` shape already carries `is_primary`.
      if (result.value.secondaryContact) {
        const secondaryContactAudit = await deps.audit.recordInTx(
          tx,
          deps.tenant,
          {
            type: 'contact_created',
            actorUserId: meta.actorUserId,
            requestId: meta.requestId,
            summary: `contact_created for member ${result.value.member.memberId}`,
            payload: {
              member_id: result.value.member.memberId,
              contact_id: result.value.secondaryContact.contactId,
              is_primary: false,
            },
          },
        );
        if (!secondaryContactAudit.ok)
          throw new UseCaseAbort<RepoError>(secondaryContactAudit.error);
      }

      return result.value;
    });

    // F8-completion Slice 1 · Task 1.6 — invoke the registered onboarding
    // listeners (e.g. create the member's initial renewal cycle) POST-COMMIT,
    // after the create tx above has committed durably. Each listener opens
    // its OWN tenant tx (the factory does) and is best-effort: this is the
    // ONLY swallow site in F8-completion. There is no tx to roll back and no
    // webhook retry to heal it, so a failure is logged + counted + ignored —
    // it must NEVER surface a spurious error on an already-committed member.
    // Mirrors change-plan.ts:manualPlanChangeListeners exactly.
    const listeners = deps.onboardingListeners ?? [];
    if (listeners.length > 0) {
      const evt: CreateMemberListenerEvent = {
        tenantId: deps.tenant.slug,
        memberId: created.member.memberId,
        registrationDate: created.member.registrationDate.toISOString(),
        planId: created.member.planId,
        correlationId: meta.requestId,
      };
      for (const listener of listeners) {
        try {
          await listener(evt);
        } catch (e) {
          // uuid/slug identifiers ONLY — never the member entity / name /
          // email / company (PII forbidden in logs; Task 1.8 redaction).
          // INVARIANT: `err` below is a bare STRING — pino's REDACT_PATHS
          // redact by object KEY, not by scanning string VALUES, so any
          // future throwable added to the listener chain MUST keep its
          // message PII-free (the cycle table + audit payload carry zero
          // PII columns today, so PG error details cannot surface PII —
          // keep it that way).
          logger.error(
            {
              err: e instanceof Error ? e.message : String(e),
              tenantId: deps.tenant.slug,
              memberId: created.member.memberId,
            },
            '[create-member] post-commit onboardingListener threw — member already committed; logged + counted, NOT rolled back',
          );
          renewalsMetrics.bootstrapCycleCreateFailed.add(1, {
            tenant_id: deps.tenant.slug,
          });
        }
      }
    }

    return ok({
      memberId: created.member.memberId,
      contactId: created.contact.contactId,
    });
  } catch (e) {
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      if (re.code === 'repo.conflict')
        return err({ type: 'conflict', reason: re.reason });
      return err({ type: 'server_error', message: `create: ${re.code}` });
    }
    return err({ type: 'server_error', message: 'create: unexpected' });
  }
}

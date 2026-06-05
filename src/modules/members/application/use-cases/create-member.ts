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
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { asEmail } from '../../domain/value-objects/email';
import { asPhone, type Phone } from '../../domain/value-objects/phone';
import { asIsoCountryCode } from '../../domain/value-objects/iso-country-code';
import { asTaxId, type TaxId } from '../../domain/value-objects/tax-id';
import {
  asOverrideReason,
  OVERRIDE_REASON_CODES,
} from '../../domain/value-objects/override-reason';
import { checkTurnoverBand } from '../../domain/policies/turnover-policy';
import { checkAgeEligibility } from '../../domain/policies/age-eligibility-policy';
import { checkStartupDuration } from '../../domain/policies/startup-duration-policy';
import { asPlanId } from '../../domain/member';
import type { Member, MemberId } from '../../domain/member';
import type { Contact, ContactId } from '../../domain/contact';
import type { MemberRepo, RepoError } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { PlanLookupPort } from '../ports/plan-lookup-port';
import type { MemberNumberAllocatorPort } from '../ports/member-number-allocator-port';
import { UseCaseAbort } from '../tx-abort';

// --- Input schema ------------------------------------------------------------

export const createMemberSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  legal_entity_type: z.string().max(100).nullable().optional(),
  country: z.string().length(2),
  tax_id: z.string().max(50).nullable().optional(),
  website: z.string().max(200).url().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  address_line1: z.string().max(200).nullable().optional(),
  address_line2: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  province: z.string().max(100).nullable().optional(),
  postal_code: z.string().max(20).nullable().optional(),
  founded_year: z.number().int().min(1800).max(2100).nullable().optional(),
  turnover_thb: z.number().int().nonnegative().nullable().optional(),
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
  override_reason_code: z.enum(OVERRIDE_REASON_CODES).nullable().optional(),
  override_reason_note: z.string().max(500).nullable().optional(),
  confirm_soft_duplicate: z.boolean().optional(),
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
  | { type: 'conflict'; reason: string }
  | { type: 'audit_failed' }
  | { type: 'server_error'; message: string };

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
        legalEntityType: data.legal_entity_type ?? null,
        country: country.value,
        taxId,
        website: data.website ?? null,
        description: data.description ?? null,
        foundedYear: data.founded_year ?? null,
        turnoverThb: data.turnover_thb ?? null,
        planId: plan.planId,
        planYear: data.plan_year,
        registrationDate: regDate,
        registrationFeePaid: false,
        lastActivityAt: null,
        notes: null,
        addressLine1: data.address_line1 ?? null,
        addressLine2: data.address_line2 ?? null,
        city: data.city ?? null,
        province: data.province ?? null,
        postalCode: data.postal_code ?? null,
        status: 'active',
        archivedAt: null,
      };

      const result = await deps.memberRepo.createWithPrimaryContactInTx(tx, {
        member: memberDraft,
        primaryContact: contactDraft,
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
        summary: `member_number_assigned ${memberNumber}`,
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

      return result.value;
    });

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

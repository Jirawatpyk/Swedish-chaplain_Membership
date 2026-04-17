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
import { asPhone } from '../../domain/value-objects/phone';
import { asIsoCountryCode } from '../../domain/value-objects/iso-country-code';
import { asTaxId } from '../../domain/value-objects/tax-id';
import {
  asOverrideReason,
  OVERRIDE_REASON_CODES,
} from '../../domain/value-objects/override-reason';
import { checkTurnoverBand } from '../../domain/policies/turnover-policy';
import { checkAgeEligibility } from '../../domain/policies/age-eligibility-policy';
import { checkStartupDuration } from '../../domain/policies/startup-duration-policy';
import { asPlanId, asTenantId } from '../../domain/member';
import type { Member, MemberId } from '../../domain/member';
import type { Contact, ContactId } from '../../domain/contact';
import type { UserId } from '../../domain/value-objects/user-id';
import type { MemberRepo } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { PlanLookupPort } from '../ports/plan-lookup-port';

// --- Input schema ------------------------------------------------------------

export const createMemberSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  legal_entity_type: z.string().max(100).nullable().optional(),
  country: z.string().length(2),
  tax_id: z.string().max(50).nullable().optional(),
  website: z.string().max(200).url().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
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

  let phone: ReturnType<typeof asPhone> extends Result<infer P, unknown>
    ? P | null
    : never = null;
  if (data.primary_contact.phone) {
    const r = asPhone(data.primary_contact.phone);
    if (!r.ok) return err({ type: 'invalid_phone' });
    phone = r.value;
  }

  let taxId: ReturnType<typeof asTaxId> extends Result<infer T, unknown>
    ? T | null
    : never = null;
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

  // 6. Assemble the draft and persist
  const memberId = deps.idFactory.memberId();
  const contactId = deps.idFactory.contactId();
  const memberDraft: Omit<Member, 'createdAt' | 'updatedAt'> = {
    tenantId: asTenantId(deps.tenant.slug),
    memberId,
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
    status: 'active',
    archivedAt: null,
  };
  const contactDraft: Omit<Contact, 'createdAt' | 'updatedAt' | 'memberId'> = {
    tenantId: asTenantId(deps.tenant.slug),
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
    removedAt: null,
  };

  const createResult = await runInTenant(deps.tenant, async (tx) => {
    const created = await deps.memberRepo.createWithPrimaryContactInTx(tx, {
      member: memberDraft,
      primaryContact: contactDraft,
    });
    if (!created.ok) return created;

    const memberAudit = await deps.audit.recordInTx(tx, deps.tenant, {
      type: 'member_created',
      actorUserId: meta.actorUserId,
      requestId: meta.requestId,
      summary: `member_created ${created.value.member.companyName}`,
      payload: {
        member_id: created.value.member.memberId,
        company_name: created.value.member.companyName,
        plan_id: created.value.member.planId,
        plan_year: created.value.member.planYear,
        primary_contact_id: created.value.contact.contactId,
      },
    });
    if (!memberAudit.ok) return err(memberAudit.error);

    const contactAudit = await deps.audit.recordInTx(tx, deps.tenant, {
      type: 'contact_created',
      actorUserId: meta.actorUserId,
      requestId: meta.requestId,
      summary: `contact_created for member ${created.value.member.memberId}`,
      payload: {
        member_id: created.value.member.memberId,
        contact_id: created.value.contact.contactId,
        is_primary: true,
      },
    });
    if (!contactAudit.ok) return err(contactAudit.error);

    return ok(created.value);
  });

  if (!createResult.ok) {
    if (createResult.error.code === 'repo.conflict') {
      return err({ type: 'conflict', reason: createResult.error.reason });
    }
    return err({
      type: 'server_error',
      message: `create: ${createResult.error.code}`,
    });
  }

  return ok({
    memberId: createResult.value.member.memberId,
    contactId: createResult.value.contact.contactId,
  });
}

// Silence unused-type warnings from the phantom Result<infer> helpers above.
void ({} as UserId);

/**
 * `update-member` use case (T078, US3 FR-004).
 *
 * Partial update on a Member aggregate. Diff-tracked so the audit
 * `member_updated` event carries `{ member_id, fields_changed, diff }`
 * per data-model.md § 4.
 *
 * Pure field updates only — plan change goes through `change-plan.ts`
 * (T079) because it has additional bundle-change semantics.
 *
 * Field-level Domain validation is re-applied on the patched fields
 * (TaxId country-aware, Email on contact — contacts have their own use
 * case). The caller (API route) already runs zod shape validation.
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  asIsoCountryCode,
  type IsoCountryCode,
} from '../../domain/value-objects/iso-country-code';
import { asTaxId } from '../../domain/value-objects/tax-id';
import type { Member, MemberId } from '../../domain/member';
import type { MemberRepo, MemberPatch } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import { UseCaseAbort } from '../tx-abort';

// --- Input schema ------------------------------------------------------------

export const updateMemberSchema = z
  .object({
    company_name: z.string().trim().min(1).max(200).optional(),
    legal_entity_type: z.string().max(100).nullable().optional(),
    country: z.string().length(2).optional(),
    tax_id: z.string().max(50).nullable().optional(),
    website: z.string().max(200).url().nullable().optional().or(z.literal('')),
    description: z.string().max(2000).nullable().optional(),
    address_line1: z.string().max(200).nullable().optional(),
    address_line2: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    province: z.string().max(100).nullable().optional(),
    postal_code: z.string().max(20).nullable().optional(),
    founded_year: z.number().int().min(1800).max(2100).nullable().optional(),
    turnover_thb: z.number().int().nonnegative().nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  })
  .strict();

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// --- Errors ------------------------------------------------------------------

export type UpdateMemberError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'invalid_country' }
  | { type: 'invalid_tax_id'; code: string }
  | { type: 'not_found' }
  | { type: 'server_error'; message: string };

// --- Deps --------------------------------------------------------------------

export type UpdateMemberDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  audit: AuditPort;
  clock: ClockPort;
};

export type UpdateMemberCallMeta = {
  actorUserId: string;
  requestId: string;
};

// --- Implementation ----------------------------------------------------------

/** Diff helper: record only fields present in the patch that changed value. */
function buildDiff(
  current: Member,
  patch: MemberPatch,
): { fieldsChanged: string[]; diff: Record<string, { old: unknown; new: unknown }> } {
  const fieldsChanged: string[] = [];
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of Object.keys(patch) as (keyof MemberPatch)[]) {
    if (patch[key] === undefined) continue;
    const currentVal = current[key as keyof Member];
    if (currentVal !== patch[key]) {
      fieldsChanged.push(key as string);
      diff[key as string] = { old: currentVal, new: patch[key] };
    }
  }
  return { fieldsChanged, diff };
}

export async function updateMember(
  memberId: MemberId,
  input: unknown,
  meta: UpdateMemberCallMeta,
  deps: UpdateMemberDeps,
): Promise<Result<Member, UpdateMemberError>> {
  // 1. zod shape
  const parsed = updateMemberSchema.safeParse(input);
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

  // 2. Validate the new country up-front (independent of current state) so a
  //    bad country fast-fails before we open a transaction.
  let validatedCountry: IsoCountryCode | undefined;
  if (data.country !== undefined) {
    const r = asIsoCountryCode(data.country);
    if (!r.ok) return err({ type: 'invalid_country' });
    validatedCountry = r.value;
  }

  // 3. M1 — read+lock current, build patch, persist, and audit in ONE tx.
  //    The diff base is read via findByIdInTx (SELECT ... FOR UPDATE) INSIDE
  //    the transaction so a concurrent archive / plan-change between read and
  //    write can no longer produce a stale audit diff or apply an edit to a
  //    just-mutated row (matches the inline-edit pattern). VO-validation and
  //    not-found failures abort via UseCaseAbort (throw-to-rollback) and
  //    surface as typed errors through the outer catch.
  //    Build patch in a writable intermediate then cast — the Member type is
  //    deeply readonly so we can't assign into it directly.
  type MutablePatch = { -readonly [K in keyof MemberPatch]?: MemberPatch[K] };
  try {
    const outcome = await runInTenant(deps.tenant, async (tx) => {
      const currentResult = await deps.memberRepo.findByIdInTx(tx, memberId);
      if (!currentResult.ok) {
        throw new UseCaseAbort<UpdateMemberError>(
          currentResult.error.code === 'repo.not_found'
            ? { type: 'not_found' }
            : {
                type: 'server_error',
                message: `lookup: ${currentResult.error.code}`,
              },
        );
      }
      const current = currentResult.value;

      const draft: MutablePatch = {};
      if (data.company_name !== undefined)
        draft.companyName = data.company_name.trim();
      if (data.legal_entity_type !== undefined)
        draft.legalEntityType = data.legal_entity_type;
      if (validatedCountry !== undefined) draft.country = validatedCountry;
      if (data.tax_id !== undefined) {
        if (data.tax_id === null) {
          draft.taxId = null;
        } else {
          const countryForTaxId = validatedCountry ?? current.country;
          const r = asTaxId(data.tax_id, countryForTaxId);
          if (!r.ok)
            throw new UseCaseAbort<UpdateMemberError>({
              type: 'invalid_tax_id',
              code: r.error.code,
            });
          draft.taxId = r.value;
        }
      }
      if (data.website !== undefined) draft.website = data.website || null;
      if (data.description !== undefined) draft.description = data.description;
      if (data.address_line1 !== undefined)
        draft.addressLine1 = data.address_line1;
      if (data.address_line2 !== undefined)
        draft.addressLine2 = data.address_line2;
      if (data.city !== undefined) draft.city = data.city;
      if (data.province !== undefined) draft.province = data.province;
      if (data.postal_code !== undefined) draft.postalCode = data.postal_code;
      if (data.founded_year !== undefined) draft.foundedYear = data.founded_year;
      if (data.turnover_thb !== undefined) draft.turnoverThb = data.turnover_thb;
      if (data.notes !== undefined) draft.notes = data.notes;
      const patch = draft as MemberPatch;

      const { fieldsChanged, diff } = buildDiff(current, patch);
      if (fieldsChanged.length === 0) {
        // No-op — return current unchanged without an audit row.
        return current;
      }

      const persistResult = await deps.memberRepo.updateFieldsInTx(
        tx,
        memberId,
        patch,
      );
      if (!persistResult.ok) {
        throw new UseCaseAbort<UpdateMemberError>({
          type: 'server_error',
          message: `update:${persistResult.error.code}`,
        });
      }

      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_updated',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `member_updated ${memberId} (${fieldsChanged.length} fields)`,
        payload: {
          member_id: memberId,
          fields_changed: fieldsChanged,
          diff,
        },
      });
      if (!auditResult.ok) {
        throw new UseCaseAbort<UpdateMemberError>({
          type: 'server_error',
          message: 'audit_failed',
        });
      }

      return persistResult.value;
    });

    return ok(outcome);
  } catch (e) {
    if (e instanceof UseCaseAbort) {
      return err(e.error as UpdateMemberError);
    }
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

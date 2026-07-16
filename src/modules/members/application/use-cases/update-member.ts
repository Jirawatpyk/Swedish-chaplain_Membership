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
import { hasDangerousUrlScheme } from '@/lib/safe-url';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  asIsoCountryCode,
  type IsoCountryCode,
} from '../../domain/value-objects/iso-country-code';
import { asTaxId } from '../../domain/value-objects/tax-id';
// Review fix (Finding 1) — close `legal_entity_type` to the 12-code
// catalogue here too (was client-only, see create-member.ts for the
// full rationale).
import { LEGAL_ENTITY_TYPES } from '../../domain/value-objects/legal-entity-type';
import { BILLING_CYCLES, type Member, type MemberId } from '../../domain/member';
import type { MemberRepo, MemberPatch } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import { UseCaseAbort } from '../tx-abort';

// --- Input schema ------------------------------------------------------------

export const updateMemberSchema = z
  .object({
    company_name: z.string().trim().min(1).max(200).optional(),
    // Review fix (Finding 1) — closed to the 12-code catalogue, mirroring
    // create-member.ts + the client's buildMemberFormSchema. Accepts a
    // valid code, `null`, or "unset" (`undefined` / `''`) — an edit to an
    // unrelated field must never be blocked by this one.
    legal_entity_type: z.enum(LEGAL_ENTITY_TYPES).nullable().optional().or(z.literal('')),
    country: z.string().length(2).optional(),
    tax_id: z.string().max(50).nullable().optional(),
    // 059 / PR-A — the §86/4 VAT-registrant flag, RECORDED not derived
    // (never infer it from legal_entity_type). Mirrors is_head_office:
    // admin-managed edit, applied to the patch below.
    is_vat_registered: z.boolean().optional(),
    // 065 §5.1 — per-member billing cadence (admin-managed edit). Optional on
    // update (mirrors is_vat_registered): absent from a partial patch means
    // unchanged; the DB column is NOT NULL so an existing row always has one.
    billing_cycle: z.enum(BILLING_CYCLES).optional(),
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
    address_line1: z.string().max(200).nullable().optional(),
    address_line2: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    province: z.string().max(100).nullable().optional(),
    postal_code: z.string().max(20).nullable().optional(),
    sub_district: z.string().max(100).nullable().optional(),
    founded_year: z.number().int().min(1800).max(2100).nullable().optional(),
    turnover_thb: z.number().int().nonnegative().nullable().optional(),
    registered_capital_thb: z.number().int().nonnegative().nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    // 088 US3 (FR-008) — §86/4 Head-Office / Branch particular, admin-managed.
    // `is_head_office=true` = สำนักงานใหญ่; a branch carries a 5-digit code.
    is_head_office: z.boolean().optional(),
    branch_code: z
      .string()
      .regex(/^\d{5}$/, 'branch_code must be exactly 5 digits')
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Mirror the DB CHECK `members_branch_pairing_ck` + the member-identity
    // snapshot VO superRefine: a head office carries a NULL code; a branch
    // carries a 5-digit code. Fires only when `is_head_office` is present — the
    // admin form always sends BOTH fields together, so the pair is validated as
    // one (the DB CHECK is the backstop for any partial-only request). A failure
    // surfaces as `invalid_body` (400) at the route.
    if (data.is_head_office === true && data.branch_code != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['branch_code'],
        message: 'a head-office member must not carry a branch code',
      });
    }
    if (data.is_head_office === false && data.branch_code == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['branch_code'],
        message: 'a branch member requires a 5-digit branch code',
      });
    }
  });

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// --- Errors ------------------------------------------------------------------

export type UpdateMemberError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'invalid_country' }
  | { type: 'invalid_tax_id'; code: string }
  // 059 / PR-A Task 4 — registrant ⇒ TIN invariant, enforced against the
  // RESULTING state (current merged with the patch) — see the check in the
  // use-case body below for why this cannot live in updateMemberSchema.
  | { type: 'vat_registrant_requires_tax_id' }
  // 059 / PR-A Task 5 — branch ⇒ VAT-registrant invariant, mirrors the DB
  // CHECK `members_branch_pairing_ck` (migration 0252) and is checked
  // against the RESULTING state for the exact same reason as the invariant
  // above — see the check in the use-case body below.
  | { type: 'branch_requires_vat_registrant' }
  // Pre-existing since 0232/0236 (latent), surfaced by the 0248 tightening —
  // the head-office ⇔ branch-code STRUCTURAL pairing (leg 1: a head office
  // must carry NO branch code; leg 2's code half: a branch must carry one),
  // checked against the RESULTING state. Distinct from
  // `branch_requires_vat_registrant` above, which only covers leg 2's
  // `is_vat_registered` half. Mirrors updateMemberSchema's superRefine,
  // which validates the SAME relationship but only on the patch in
  // isolation (and only fires when `is_head_office` is present) — a PATCH
  // touching ONLY `branch_code` used to sail past both that superRefine and
  // the narrower `branch_requires_vat_registrant` gate straight into a raw
  // Postgres CHECK-violation 500. See the check in the use-case body below.
  | { type: 'head_office_branch_code_mismatch' }
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

/**
 * `member_updated` audit-diff fields whose VALUE must never be persisted —
 * only the FACT that they changed (`fieldsChanged` already carries that).
 *
 * `taxId` — for a foreign natural person this column holds a passport /
 * work-permit number, not a Thai TIN. `audit_log` is append-only (5-year
 * retention; nothing in `src/` ever issues an `UPDATE` against it — grep
 * `.update(auditLog` before assuming otherwise), so a raw value written
 * here SURVIVES a GDPR Art. 17 / PDPA erasure: `eraseMember` NULLs
 * `members.tax_id`, but cannot reach this audit row. GUARD 3
 * (059 / member-tax-correctness).
 */
const AUDIT_DIFF_VALUE_REDACTED_FIELDS: ReadonlySet<string> = new Set(['taxId']);

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
      // GUARD 3 — record the CHANGE, never the VALUE, for fields listed in
      // AUDIT_DIFF_VALUE_REDACTED_FIELDS. `fields_changed` above already
      // preserves accountability (who changed WHAT field, when); the raw
      // value adds nothing an auditor requires and is a retention liability
      // audit_log cannot un-write.
      diff[key as string] = AUDIT_DIFF_VALUE_REDACTED_FIELDS.has(key as string)
        ? {
            old: currentVal === null ? null : '<set>',
            new: patch[key] === null ? '<cleared>' : '<set>',
          }
        : { old: currentVal, new: patch[key] };
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
      // Collapses '' (client Select "nothing picked") to `null` — see
      // create-member.ts for why `||` is the correct narrowing here.
      if (data.legal_entity_type !== undefined)
        draft.legalEntityType = data.legal_entity_type || null;
      // 088 US3 — §86/4 branch particular. The zod superRefine above + the DB
      // CHECK enforce the head-office ⇔ branch-code pairing; here we just thread
      // the validated pair into the patch (buildDiff surfaces them on the
      // `member_updated` audit's fields_changed + diff — no new event type).
      if (data.is_head_office !== undefined)
        draft.isHeadOffice = data.is_head_office;
      if (data.branch_code !== undefined) draft.branchCode = data.branch_code;
      // 059 / PR-A — the §86/4 VAT-registrant flag (admin-managed edit).
      if (data.is_vat_registered !== undefined)
        draft.isVatRegistered = data.is_vat_registered;
      // 065 §5.1 — per-member billing cadence (admin-managed edit). buildDiff
      // surfaces it on the member_updated audit's fields_changed + diff.
      if (data.billing_cycle !== undefined)
        draft.billingCycle = data.billing_cycle;
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
      if (data.sub_district !== undefined) draft.subDistrict = data.sub_district;
      if (data.founded_year !== undefined) draft.foundedYear = data.founded_year;
      if (data.turnover_thb !== undefined) draft.turnoverThb = data.turnover_thb;
      if (data.registered_capital_thb !== undefined)
        draft.registeredCapitalThb = data.registered_capital_thb;
      if (data.notes !== undefined) draft.notes = data.notes;
      const patch = draft as MemberPatch;

      // 059 / PR-A Task 4 — registrant ⇒ TIN invariant (ประกาศอธิบดีฯ 196 +
      // 199 are a PAIR: a VAT-registrant buyer must carry BOTH the TIN and
      // the head-office/branch line, or a §86/4 document prints defective).
      //
      // Deliberately NOT expressed in updateMemberSchema's superRefine —
      // updateMemberSchema validates a PARTIAL patch, where `is_vat_registered`
      // and `tax_id` may each be absent from any given request. A patch that
      // only flips `is_vat_registered: true` looks fine in isolation (tax_id
      // simply isn't part of THIS request); a patch that only clears `tax_id`
      // looks fine too (is_vat_registered isn't part of THIS request either)
      // — but either can leave the member registrant-with-no-TIN. Only the
      // RESULTING state (current merged with the patch) can tell, and only
      // the use case has `current` in scope (read above, before patching). If
      // a future refactor "helpfully" moves this into the schema, it
      // reintroduces the hole this closes — keep it here.
      //
      // Gated on the patch actually touching one of the two fields (same
      // "fires only when present" posture as the is_head_office/branch_code
      // superRefine above) so an edit to an unrelated field is never blocked
      // by a member already in a legacy-violating state.
      if (patch.isVatRegistered !== undefined || patch.taxId !== undefined) {
        const resultingIsVatRegistered =
          patch.isVatRegistered !== undefined
            ? patch.isVatRegistered
            : current.isVatRegistered;
        const resultingTaxId =
          patch.taxId !== undefined ? patch.taxId : current.taxId;
        if (resultingIsVatRegistered && resultingTaxId === null) {
          throw new UseCaseAbort<UpdateMemberError>({
            type: 'vat_registrant_requires_tax_id',
          });
        }
      }

      // 059 / PR-A Task 5 — branch-pairing invariants, mirrors the DB CHECK
      // `members_branch_pairing_ck` (migration 0252) in full: leg 1 (a head
      // office carries NO branch code), and leg 2 (a branch carries BOTH a
      // 5-digit code AND the VAT-registrant flag). Checked against the
      // RESULTING state for the exact same reason as the registrant ⇒ TIN
      // check above.
      //
      // Deliberately NOT expressed in updateMemberSchema's superRefine — same
      // reasoning as the registrant ⇒ TIN check above. `is_head_office`,
      // `branch_code`, and `is_vat_registered` may each be absent from any
      // given partial patch: a patch that only flips `is_vat_registered:
      // false` looks fine in isolation (is_head_office isn't part of THIS
      // request), but if the member is ALREADY a branch, the resulting row
      // is a non-registrant branch. Only the RESULTING state (current
      // merged with the patch) can tell, and only the use case has `current`
      // in scope.
      //
      // FIX (pre-existing since 0232/0236, surfaced by the 0248 tightening)
      // — this gate used to trigger only on `is_head_office` /
      // `is_vat_registered`, and updateMemberSchema's superRefine only
      // trigger on `is_head_office`. A patch touching ONLY `branch_code`
      // (e.g. `{ branch_code: '00001' }` on a head-office member, or
      // `{ branch_code: null }` on a branch) sailed past BOTH gates straight
      // into `updateFieldsInTx` and a raw Postgres CHECK violation → 500.
      // The gate now fires whenever the patch touches ANY of the three
      // fields in the pairing rule, and validates the FULL resulting triple.
      if (
        patch.isHeadOffice !== undefined ||
        patch.branchCode !== undefined ||
        patch.isVatRegistered !== undefined
      ) {
        const resultingIsHeadOffice =
          patch.isHeadOffice !== undefined
            ? patch.isHeadOffice
            : (current.isHeadOffice ?? true);
        const resultingBranchCode =
          patch.branchCode !== undefined
            ? patch.branchCode
            : (current.branchCode ?? null);
        const resultingIsVatRegisteredForBranch =
          patch.isVatRegistered !== undefined
            ? patch.isVatRegistered
            : current.isVatRegistered;

        if (resultingIsHeadOffice === true) {
          // Leg 1 — a head office must not carry a branch code.
          if (resultingBranchCode != null) {
            throw new UseCaseAbort<UpdateMemberError>({
              type: 'head_office_branch_code_mismatch',
            });
          }
        } else {
          // Leg 2 — a branch requires BOTH a 5-digit code AND the
          // registrant flag. Code-presence is checked first so a
          // stranded-branch patch (code cleared, registrant untouched)
          // reports the structural mismatch rather than the registrant one.
          if (resultingBranchCode == null) {
            throw new UseCaseAbort<UpdateMemberError>({
              type: 'head_office_branch_code_mismatch',
            });
          }
          if (!resultingIsVatRegisteredForBranch) {
            throw new UseCaseAbort<UpdateMemberError>({
              type: 'branch_requires_vat_registrant',
            });
          }
        }
      }

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

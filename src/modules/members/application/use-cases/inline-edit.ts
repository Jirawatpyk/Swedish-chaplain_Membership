/**
 * `inline-edit` use case (T105, US4 FR-040/041).
 *
 * Whitelisted single-field optimistic updates from the directory table.
 * Only low-risk fields are allowed: `status`, `country`, `notes`.
 *
 * The caller sends the field name + new value; the use case validates,
 * applies the domain state transition (for status), persists, and emits
 * the matching audit event. Returns the updated Member for optimistic
 * UI reconciliation (or a typed error for rollback).
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  setStatus,
  type Member,
  type MemberId,
} from '../../domain/member';
import { asIsoCountryCode } from '../../domain/value-objects/iso-country-code';
import type { MemberRepo, MemberPatch } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';

// --- Constants ---------------------------------------------------------------

export const INLINE_EDIT_FIELDS = ['status', 'country', 'notes'] as const;
export type InlineEditField = (typeof INLINE_EDIT_FIELDS)[number];

// --- Input schema ------------------------------------------------------------

export const inlineEditSchema = z
  .object({
    field: z.enum(INLINE_EDIT_FIELDS),
    value: z.union([z.string(), z.null()]),
  })
  .strict();

export type InlineEditInput = z.infer<typeof inlineEditSchema>;

// --- Errors ------------------------------------------------------------------

export type InlineEditError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'invalid_field_value'; field: string; reason: string }
  | { type: 'not_found' }
  | { type: 'state_error'; code: string }
  | { type: 'server_error'; message: string };

// --- Deps --------------------------------------------------------------------

export type InlineEditDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  audit: AuditPort;
  clock: ClockPort;
};

export type InlineEditMeta = {
  actorUserId: string;
  requestId: string;
};

// --- Implementation ----------------------------------------------------------

export async function inlineEdit(
  memberId: MemberId,
  input: unknown,
  meta: InlineEditMeta,
  deps: InlineEditDeps,
): Promise<Result<Member, InlineEditError>> {
  // 1. Validate input shape
  const parsed = inlineEditSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const { field, value } = parsed.data;

  // 2. Fetch current member
  const currentResult = await deps.memberRepo.findById(deps.tenant, memberId);
  if (!currentResult.ok) {
    if (currentResult.error.code === 'repo.not_found')
      return err({ type: 'not_found' });
    return err({
      type: 'server_error',
      message: `lookup: ${currentResult.error.code}`,
    });
  }
  const current = currentResult.value;
  const now = deps.clock.now();

  // 3. Field-specific validation and application
  switch (field) {
    case 'status': {
      if (value !== 'active' && value !== 'inactive') {
        return err({
          type: 'invalid_field_value',
          field: 'status',
          reason: 'Status must be "active" or "inactive" for inline edit. Use archive/undelete for archived status.',
        });
      }
      const statusResult = setStatus(current, value as 'active' | 'inactive', now);
      if (!statusResult.ok) {
        return err({ type: 'state_error', code: statusResult.error.code });
      }

      try {
        const updated = await runInTenant(deps.tenant, async (tx) => {
          // Round-2 review C-5: use updateStatusInTx(tx, ...) so the
          // status update joins the ambient transaction with the audit
          // row. Passing deps.tenant would open a new connection outside
          // the tx, creating a partial-state risk if audit write fails.
          const persistResult = await deps.memberRepo.updateStatusInTx(
            tx,
            memberId,
            statusResult.value,
          );
          if (!persistResult.ok) throw new Error(`persist:${persistResult.error.code}`);

          const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
            type: 'member_status_changed',
            actorUserId: meta.actorUserId,
            requestId: meta.requestId,
            summary: `inline status change ${current.status} → ${value} for member ${memberId}`,
            payload: {
              member_id: memberId,
              old_status: current.status,
              new_status: value,
              inline_edit: true,
            },
          });
          if (!auditResult.ok) throw new Error('audit_failed');

          return persistResult.value;
        });
        return ok(updated);
      } catch {
        // Sanitize: don't leak internal detail (round-2 review S-2).
        return err({ type: 'server_error', message: 'inline edit failed' });
      }
    }

    case 'country': {
      if (value === null || value === '') {
        return err({
          type: 'invalid_field_value',
          field: 'country',
          reason: 'Country cannot be empty.',
        });
      }
      const countryResult = asIsoCountryCode(value);
      if (!countryResult.ok) {
        return err({
          type: 'invalid_field_value',
          field: 'country',
          reason: `Invalid ISO 3166-1 alpha-2 code: ${value}`,
        });
      }
      if (countryResult.value === current.country) {
        return ok(current); // No-op
      }

      const patch: MemberPatch = { country: countryResult.value };
      try {
        const updated = await runInTenant(deps.tenant, async (tx) => {
          const persistResult = await deps.memberRepo.updateFieldsInTx(
            tx,
            memberId,
            patch,
          );
          if (!persistResult.ok) throw new Error(`persist:${persistResult.error.code}`);

          const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
            type: 'member_updated',
            actorUserId: meta.actorUserId,
            requestId: meta.requestId,
            summary: `inline country change for member ${memberId}`,
            payload: {
              member_id: memberId,
              fields_changed: ['country'],
              diff: {
                country: { old: current.country, new: countryResult.value },
              },
              inline_edit: true,
            },
          });
          if (!auditResult.ok) throw new Error('audit_failed');

          return persistResult.value;
        });
        return ok(updated);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err({ type: 'server_error', message: msg });
      }
    }

    case 'notes': {
      if (value !== null && value.length > 4000) {
        return err({
          type: 'invalid_field_value',
          field: 'notes',
          reason: 'Notes cannot exceed 4000 characters.',
        });
      }
      if (value === current.notes) {
        return ok(current); // No-op
      }

      const patch: MemberPatch = { notes: value };
      try {
        const updated = await runInTenant(deps.tenant, async (tx) => {
          const persistResult = await deps.memberRepo.updateFieldsInTx(
            tx,
            memberId,
            patch,
          );
          if (!persistResult.ok) throw new Error(`persist:${persistResult.error.code}`);

          const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
            type: 'member_updated',
            actorUserId: meta.actorUserId,
            requestId: meta.requestId,
            summary: `inline notes edit for member ${memberId}`,
            payload: {
              member_id: memberId,
              fields_changed: ['notes'],
              // Notes content is NOT included in audit diff for privacy
              inline_edit: true,
            },
          });
          if (!auditResult.ok) throw new Error('audit_failed');

          return persistResult.value;
        });
        return ok(updated);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err({ type: 'server_error', message: msg });
      }
    }
  }
}

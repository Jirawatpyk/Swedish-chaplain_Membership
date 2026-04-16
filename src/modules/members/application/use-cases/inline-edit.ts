/**
 * `inline-edit` use case (T105, US4 FR-040).
 *
 * Whitelisted single-field optimistic updates from the directory table.
 * Only low-risk fields are allowed: `status`, `country`, `notes`.
 *
 * Round-3 review N-C1: fetch + validate + mutate + audit run inside ONE
 * `runInTenant` transaction with `findByIdInTx` using `SELECT ... FOR
 * UPDATE`. Prior impl opened two separate transactions (one for findById,
 * one for the write) — a concurrent actor could archive / change-plan the
 * row in between and the write would silently overwrite.
 *
 * Round-3 review N-C2 + N-I2: all catch blocks return a sanitized
 * `'inline edit failed'` message — no raw Postgres detail leaks through.
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

// --- Internal error classes (control flow inside runInTenant) ---------------

class InlineEditNotFoundError extends Error {
  constructor() {
    super('not_found');
  }
}

class InlineEditStateError extends Error {
  constructor(public readonly stateCode: string) {
    super('state_error');
  }
}

class InlineEditInvalidFieldError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super('invalid_field_value');
  }
}

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
  const now = deps.clock.now();

  // 2. Single atomic transaction: lock row + validate + write + audit.
  //    Prevents TOCTOU lost-update (round-3 N-C1).
  try {
    const updated = await runInTenant(deps.tenant, async (tx) => {
      // SELECT ... FOR UPDATE
      const currentResult = await deps.memberRepo.findByIdInTx(tx, memberId);
      if (!currentResult.ok) {
        if (currentResult.error.code === 'repo.not_found') {
          throw new InlineEditNotFoundError();
        }
        throw new Error('lookup_failed');
      }
      const current = currentResult.value;

      switch (field) {
        case 'status': {
          if (value !== 'active' && value !== 'inactive') {
            throw new InlineEditInvalidFieldError(
              'status',
              'Status must be "active" or "inactive" for inline edit. Use archive/undelete for archived status.',
            );
          }
          const statusResult = setStatus(
            current,
            value as 'active' | 'inactive',
            now,
          );
          if (!statusResult.ok) {
            throw new InlineEditStateError(statusResult.error.code);
          }

          const persistResult = await deps.memberRepo.updateStatusInTx(
            tx,
            memberId,
            statusResult.value,
          );
          if (!persistResult.ok) throw new Error('persist_failed');

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
        }

        case 'country': {
          if (value === null || value === '') {
            throw new InlineEditInvalidFieldError(
              'country',
              'Country cannot be empty.',
            );
          }
          const countryResult = asIsoCountryCode(value);
          if (!countryResult.ok) {
            throw new InlineEditInvalidFieldError(
              'country',
              `Invalid ISO 3166-1 alpha-2 code: ${value}`,
            );
          }
          if (countryResult.value === current.country) {
            return current; // No-op — still inside tx but nothing persisted
          }

          const patch: MemberPatch = { country: countryResult.value };
          const persistResult = await deps.memberRepo.updateFieldsInTx(
            tx,
            memberId,
            patch,
          );
          if (!persistResult.ok) throw new Error('persist_failed');

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
        }

        case 'notes': {
          if (value !== null && value.length > 4000) {
            throw new InlineEditInvalidFieldError(
              'notes',
              'Notes cannot exceed 4000 characters.',
            );
          }
          if (value === current.notes) {
            return current; // No-op
          }

          const patch: MemberPatch = { notes: value };
          const persistResult = await deps.memberRepo.updateFieldsInTx(
            tx,
            memberId,
            patch,
          );
          if (!persistResult.ok) throw new Error('persist_failed');

          const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
            type: 'member_updated',
            actorUserId: meta.actorUserId,
            requestId: meta.requestId,
            summary: `inline notes edit for member ${memberId}`,
            payload: {
              member_id: memberId,
              fields_changed: ['notes'],
              // Notes content is NOT included in audit diff for privacy.
              inline_edit: true,
            },
          });
          if (!auditResult.ok) throw new Error('audit_failed');

          return persistResult.value;
        }
      }
    });

    return ok(updated);
  } catch (e) {
    // Round-3 N-C2 + N-I2: sanitized — no internal Postgres detail leaks.
    if (e instanceof InlineEditNotFoundError) {
      return err({ type: 'not_found' });
    }
    if (e instanceof InlineEditStateError) {
      return err({ type: 'state_error', code: e.stateCode });
    }
    if (e instanceof InlineEditInvalidFieldError) {
      return err({
        type: 'invalid_field_value',
        field: e.field,
        reason: e.reason,
      });
    }
    return err({ type: 'server_error', message: 'inline edit failed' });
  }
}

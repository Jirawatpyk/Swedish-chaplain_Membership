/**
 * F6 Phase 10 T113 — `pseudonymiseStaleNonMemberPii` use-case.
 *
 * Retention sweep per FR-032 / SC-011. Per-tenant scan that:
 *   1. Lists non-member + unmatched registrations older than 2 years
 *      where `pii_pseudonymised_at IS NULL` (cap at `pageSize`)
 *   2. For each row:
 *      - Replace `attendee_email` + `attendee_name` + `attendee_company`
 *        with deterministic salted SHA-256 hashes (so audit forensics
 *        can correlate without storing PII)
 *      - Stamp `pii_pseudonymised_at = NOW()`
 *      - Emit per-row `pii_pseudonymised` audit
 *   3. Emit aggregate `pii_pseudonymisation_sweep_run` audit with
 *      `rowsScanned`, `rowsPseudonymised`, `durationMs`, `passDate`
 *
 * Caller (cron handler at `/api/internal/retention/...`) wraps in
 * `runInTenant` per tenant. Use-case stays pure Application — no DB
 * client / framework imports.
 *
 * Constitution Principle III: pure Application.
 * Constitution Principle I sub-clause 2: every read + write inside the
 * caller's `runInTenant` so RLS enforces tenant scope at DB layer.
 */
import { ok, err, type Result } from '@/lib/result';
import { safeAuditEmit } from './_helpers/safe-audit-emit';
import type { TenantId } from '@/modules/members';
import type { EventRegistrationAggregate } from '../../domain/event-registration';
import type { AttendeeEmail } from '../../domain/branded-types';
import type {
  RegistrationsRepository,
  RegistrationsRepositoryError,
} from '../ports/registrations-repository';
import type { F6AuditPort, AuditEmitError } from '../ports/audit-port';
import { wrapAuditEmitFailure } from './_helpers/error-wrappers';
import { registrationsRepoErrorMessage } from './_helpers/repo-error-message';

/** 2 years lookback per FR-032. */
const RETENTION_THRESHOLD_DAYS = 730;

/** Default sweep page size — caps blast radius per run. */
const DEFAULT_PAGE_SIZE = 500;

export interface PseudonymiseStaleNonMemberPiiInput {
  readonly tenantId: TenantId;
  readonly occurredAt: Date;
  /** Optional override for the 2-year cutoff (testing convenience). */
  readonly cutoff?: Date;
  /** Optional override for page size (default 500). */
  readonly pageSize?: number;
}

export interface PseudonymiseStaleNonMemberPiiOutput {
  readonly rowsScanned: number;
  readonly rowsPseudonymised: number;
  readonly durationMs: number;
  readonly passDate: string;
}

export type PseudonymiseStaleNonMemberPiiError =
  | {
      readonly kind: 'registrations_repo_error';
      readonly message: string;
      readonly cause: RegistrationsRepositoryError;
    }
  | {
      readonly kind: 'audit_emit_failed';
      readonly message: string;
      readonly cause: AuditEmitError;
    };

export interface PseudonymisationHasher {
  /** Returns deterministic salted SHA-256 in the form `sha256:<base64url>` (max 64 chars). */
  hash(input: string): string;
}

export interface PseudonymiseStaleNonMemberPiiDeps {
  readonly registrationsRepo: RegistrationsRepository;
  readonly audit: F6AuditPort;
  readonly hasher: PseudonymisationHasher;
}

function computeCutoff(occurredAt: Date, override: Date | undefined): Date {
  if (override !== undefined) return override;
  return new Date(occurredAt.getTime() - RETENTION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
}

function ageInDays(registeredAt: Date, occurredAt: Date): number {
  return Math.floor(
    (occurredAt.getTime() - registeredAt.getTime()) / (24 * 60 * 60 * 1000),
  );
}

export async function pseudonymiseStaleNonMemberPii(
  input: PseudonymiseStaleNonMemberPiiInput,
  deps: PseudonymiseStaleNonMemberPiiDeps,
): Promise<
  Result<PseudonymiseStaleNonMemberPiiOutput, PseudonymiseStaleNonMemberPiiError>
> {
  const startedAt = Date.now();
  const cutoff = computeCutoff(input.occurredAt, input.cutoff);
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;

  // (1) List eligible rows
  const eligible = await deps.registrationsRepo.listPseudonymiseEligible(
    input.tenantId,
    cutoff,
    pageSize,
  );
  if (!eligible.ok) {
    return err({
      kind: 'registrations_repo_error',
      message: registrationsRepoErrorMessage(eligible.error),
      cause: eligible.error,
    });
  }

  let rowsPseudonymised = 0;

  // (2) Per-row: pseudonymise + emit audit
  for (const reg of eligible.value) {
    const emailHash = `sha256:${deps.hasher.hash(String(reg.attendee.email))}` as AttendeeEmail;
    const nameHash = `sha256:${deps.hasher.hash(reg.attendee.name)}`;
    const companyHash =
      reg.attendee.company !== null && reg.attendee.company !== undefined
        ? `sha256:${deps.hasher.hash(reg.attendee.company)}`
        : null;

    const updateResult = await deps.registrationsRepo.pseudonymiseRow(
      input.tenantId,
      reg.registrationId,
      emailHash,
      nameHash,
      companyHash,
      input.occurredAt,
    );
    if (!updateResult.ok) {
      return err({
        kind: 'registrations_repo_error',
        message: registrationsRepoErrorMessage(updateResult.error),
        cause: updateResult.error,
      });
    }

    // Idempotent path: if the row was already pseudonymised, skip the
    // audit emit (no behavioural change to record).
    const wasAlreadyPseudonymised = updateResult.value.piiPseudonymisedAt !== null
      && updateResult.value.piiPseudonymisedAt.getTime() !== input.occurredAt.getTime();
    if (wasAlreadyPseudonymised) continue;

    const matchType = String(reg.match.type);
    if (matchType !== 'non_member' && matchType !== 'unmatched') {
      // Filter belt-and-suspenders: skip emitting if matchType drifted.
      continue;
    }

    const emit = await safeAuditEmit(deps.audit, {
      eventType: 'pii_pseudonymised',
      tenantId: input.tenantId,
      actorType: 'cron',
      actorUserId: null,
      occurredAt: input.occurredAt,
      summary: `retention sweep pseudonymised registration ${reg.registrationId}`,
      payload: {
        severity: 'info',
        registrationId: reg.registrationId,
        matchTypeAtPseudonymisation: matchType as 'non_member' | 'unmatched',
        ageAtSweepDays: ageInDays(reg.registeredAt, input.occurredAt),
        registeredAt: reg.registeredAt.toISOString(),
      },
    });
    if (!emit.ok) {
      return err(wrapAuditEmitFailure(emit.error));
    }
    rowsPseudonymised += 1;
  }

  // (3) Macro aggregate audit
  const durationMs = Date.now() - startedAt;
  const passDate = input.occurredAt.toISOString().slice(0, 10); // YYYY-MM-DD
  const macroEmit = await safeAuditEmit(deps.audit, {
    eventType: 'pii_pseudonymisation_sweep_run',
    tenantId: input.tenantId,
    actorType: 'cron',
    actorUserId: null,
    occurredAt: input.occurredAt,
    summary: `pseudonymisation sweep scanned=${eligible.value.length} pseudonymised=${rowsPseudonymised} duration=${durationMs}ms`,
    payload: {
      severity: 'info',
      rowsScanned: eligible.value.length,
      rowsPseudonymised,
      durationMs,
      passDate,
    },
  });
  if (!macroEmit.ok) {
    return err(wrapAuditEmitFailure(macroEmit.error));
  }

  return ok({
    rowsScanned: eligible.value.length,
    rowsPseudonymised,
    durationMs,
    passDate,
  });
}

/** Helper symbol for tests + composition root unused-type-elimination. */
export type _Hint = EventRegistrationAggregate;

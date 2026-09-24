/**
 * F119 round-4 B3 — a failure of a read the approval workflow depends on,
 * with its cause kept.
 *
 * `errKind(e)` logs the error CLASS only (`e.constructor.name`, F7-5: never
 * `e.message`, which can carry a Neon error's bound parameters). Every
 * approval dependency failure used to be thrown as a plain `Error` whose
 * cause lived only in the message, so the route logged `err: 'Error'` and
 * on-call could not tell a halted-flag read from a portal-contact read from a
 * missing roster. This class carries the two things worth logging as fields:
 *
 *   - `dependency` — WHICH read failed (a fixed token, never data);
 *   - `causeKind` — the failed read's own error class or repo error code.
 *
 * Both are PII-free by construction (tokens and codes, never an email, a
 * reason or a body), so `approvalErrKind` may fold them into the string
 * every `server_error` arm already carries as `errKind`, and no pinned catch
 * site grows a branch.
 *
 * Pure Application — no framework imports.
 */
import { errKind } from '@/lib/log-id';
import type { MemberSendStanding } from './use-cases/_member-send-standing';

/** The reads the approval workflow cannot decide without. */
export type ApprovalDependency =
  /** The send-time standing was not read for the row the lock returned. */
  | 'member_send_standing'
  /** `getMembersHaltedInTenant` threw. */
  | 'member_halt_flag'
  /** The F8 membership-access lookup answered its error arm. */
  | 'membership_access'
  | 'marketing_roster'
  | 'portal_contacts'
  | 'member_company';

export class ApprovalDependencyError extends Error {
  constructor(
    public readonly dependency: ApprovalDependency,
    public readonly causeKind: string,
  ) {
    super(`approval dependency unavailable: ${dependency} (${causeKind})`);
    this.name = 'ApprovalDependencyError';
  }
}

/**
 * `errKind` that keeps an approval dependency's cause:
 * `ApprovalDependencyError:<dependency>:<causeKind>` for this class, the
 * plain error class for everything else.
 */
export function approvalErrKind(e: unknown): string {
  return e instanceof ApprovalDependencyError
    ? `${errKind(e)}:${e.dependency}:${e.causeKind}`
    : errKind(e);
}

/** The standing read that could not be answered, as the error the fail-closed arm throws. */
export function standingUnavailableError(
  standing: Extract<MemberSendStanding, { readonly kind: 'halt_read_failed' | 'access_unavailable' }>,
): ApprovalDependencyError {
  return standing.kind === 'halt_read_failed'
    ? new ApprovalDependencyError('member_halt_flag', standing.errKind)
    : new ApprovalDependencyError('membership_access', standing.errorKind);
}

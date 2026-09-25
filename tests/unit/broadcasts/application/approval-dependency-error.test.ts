/**
 * F119 round-4 B3 — `ApprovalDependencyError` / `approvalErrKind`: a failed
 * approval dependency keeps WHICH read failed and its cause through the
 * `errKind` string every `server_error` arm hands its route, instead of the
 * bare `Error` the plain throws used to log. The message carries tokens and
 * codes only — never data.
 */
import { describe, expect, it } from 'vitest';
import {
  ApprovalDependencyError,
  approvalErrKind,
  standingUnavailableError,
} from '@/modules/broadcasts/application/approval-dependency-error';

describe('approvalErrKind', () => {
  it('an approval dependency failure → ApprovalDependencyError:<dependency>:<cause>', () => {
    expect(approvalErrKind(new ApprovalDependencyError('portal_contacts', 'repo.unexpected'))).toBe(
      'ApprovalDependencyError:portal_contacts:repo.unexpected',
    );
  });

  it('anything else → the plain error class, exactly as errKind', () => {
    expect(approvalErrKind(new TypeError('pool exhausted'))).toBe('TypeError');
    expect(approvalErrKind('not an error')).toBe('unknown');
  });

  it('the message names the dependency and the cause and nothing else', () => {
    const e = new ApprovalDependencyError('marketing_roster', 'TypeError');
    expect(e.message).toBe('approval dependency unavailable: marketing_roster (TypeError)');
    expect(e.name).toBe('ApprovalDependencyError');
  });
});

describe('standingUnavailableError — which standing read failed', () => {
  it('the halt read threw → member_halt_flag with the thrown class', () => {
    expect(approvalErrKind(standingUnavailableError({ kind: 'halt_read_failed', errKind: 'TypeError' }))).toBe(
      'ApprovalDependencyError:member_halt_flag:TypeError',
    );
  });

  it('the access lookup answered its error arm → membership_access with the lookup error kind', () => {
    expect(
      approvalErrKind(standingUnavailableError({ kind: 'access_unavailable', errorKind: 'membership_access.lookup_error' })),
    ).toBe('ApprovalDependencyError:membership_access:membership_access.lookup_error');
  });
});

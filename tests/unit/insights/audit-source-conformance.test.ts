/**
 * F9 US2 (review type-finding #4) — compile-time conformance guard for the two
 * parallel audit-row contracts that span the module boundary:
 *   - auth   `AuditQueryReadRow` (owns `audit_log`; `eventType: AuditEventType`)
 *   - insights `AuditSourceRow`  (consumes via the port; `eventType: string`)
 *
 * They are a DELIBERATE boundary duplication (insights must not import auth's
 * domain `AuditEventType` union — Principle III), differing only on `eventType`.
 * Every OTHER field must stay aligned; a field added to one side but not the
 * other is a TYPE error in this file (so it fails `pnpm typecheck`), catching
 * silent drift the adapter's verbatim copy would otherwise hide.
 */
import { describe, expect, it } from 'vitest';
import type { AuditSourceRow } from '@/modules/insights/application/ports/audit-source';
import type { AuditQueryReadRow } from '@/modules/auth';

type SourceMinusEvent = Omit<AuditSourceRow, 'eventType'>;
type ReadMinusEvent = Omit<AuditQueryReadRow, 'eventType'>;

// Mutual assignability (both directions) ⇒ the non-`eventType` shape is identical.
const _sourceFromRead: SourceMinusEvent = {} as ReadMinusEvent;
const _readFromSource: ReadMinusEvent = {} as SourceMinusEvent;

describe('audit row contract conformance (auth ↔ insights)', () => {
  it('keeps AuditSourceRow and AuditQueryReadRow aligned except eventType', () => {
    void _sourceFromRead;
    void _readFromSource;
    expect(true).toBe(true);
  });
});

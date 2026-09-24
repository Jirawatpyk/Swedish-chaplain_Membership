/**
 * 106-void-on-reissue follow-up — `routeSupersedeIssues` parses an untrusted
 * JSON body, so a non-object body must degrade to "no issues", never throw
 * (a throw after a successful issue turns the success into a failure toast).
 */
import { describe, expect, it } from 'vitest';
import { routeSupersedeIssues } from '@/components/invoices/supersede-issue-routing';

describe('routeSupersedeIssues', () => {
  it.each([null, undefined, 'oops', 42])(
    'a non-object body (%s) → no issues, no throw',
    (body) => {
      expect(routeSupersedeIssues(body)).toEqual([]);
    },
  );

  it('ignores the removed legacy `supersede_warnings` string array', () => {
    expect(
      routeSupersedeIssues({ supersede_warnings: ['supersede: void of inv-old-1 threw'] }),
    ).toEqual([]);
  });

  it('maps a void failure to its bill number + link target', () => {
    expect(
      routeSupersedeIssues({
        supersede_issues: [
          { kind: 'void_threw', invoice_id: 'inv-old-1', bill_document_number: 'SC-2026-000123' },
        ],
      }),
    ).toEqual([{ messageKey: 'voidFailed', invoiceId: 'inv-old-1', number: 'SC-2026-000123' }]);
  });
});

/**
 * 108 T041 review round 4 (F4-#5) — the bulk action bar maps a server error
 * CODE to localized copy. A `state_error` whose `details.code` is
 * `no_primary_contact` needs its own copy (open the member's page and restore
 * it there), not the generic "state transition not allowed".
 */
import { describe, expect, it } from 'vitest';
import { bulkErrorKey } from '@/app/(staff)/admin/members/_components/bulk-error-key';

const has = (k: string) =>
  ['errors.state_error', 'errors.not_found', 'errors.no_primary_contact'].includes(k);

describe('bulkErrorKey (108 round 4)', () => {
  it('a state_error whose detail code is no_primary_contact gets its own copy', () => {
    expect(
      bulkErrorKey({ error: { code: 'state_error', details: { code: 'no_primary_contact' } } }, has),
    ).toBe('errors.no_primary_contact');
  });

  it('other state errors keep the generic state_error copy', () => {
    expect(
      bulkErrorKey({ error: { code: 'state_error', details: { code: 'undelete_erased' } } }, has),
    ).toBe('errors.state_error');
    expect(bulkErrorKey({ error: { code: 'state_error' } }, has)).toBe('errors.state_error');
  });

  it('a code without copy, or no code at all, is null so the caller shows unknownError', () => {
    expect(bulkErrorKey({ error: { code: 'weird' } }, has)).toBeNull();
    expect(bulkErrorKey({}, has)).toBeNull();
    expect(bulkErrorKey(undefined, has)).toBeNull();
  });
});

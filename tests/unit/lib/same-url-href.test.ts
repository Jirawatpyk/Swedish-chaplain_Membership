/**
 * PR Q review round 1b — a load error's "Try again" link reloads the same
 * page with the same query (filters, page, a resubmit id), never a stripped URL.
 */
import { describe, expect, it } from 'vitest';
import { sameUrlHref } from '@/lib/same-url-href';

describe('sameUrlHref', () => {
  it('is the bare path with no params', () => {
    expect(sameUrlHref('/portal/profile')).toBe('/portal/profile');
    expect(sameUrlHref('/portal/invoices', {})).toBe('/portal/invoices');
  });

  it('keeps every given param, a repeated one in order, and skips undefined', () => {
    expect(sameUrlHref('/portal/invoices', { q: 'acme & co', status: 'paid', page: undefined })).toBe(
      '/portal/invoices?q=acme+%26+co&status=paid',
    );
    expect(sameUrlHref('/portal/edit', { tag: ['a', 'b'] })).toBe('/portal/edit?tag=a&tag=b');
  });
});

/**
 * 107-auto-invoice flag-flip item 2 (whole-branch verdict F1) — the
 * auto-renewal review queue is `origin='auto_renewal' AND status='draft'`.
 *
 * Before this fix `isQueueView` keyed on `origin` ALONE and nothing narrowed
 * to drafts, so mixed-status was the default and only rendering of the queue:
 * a paid FY2025 §86/4 rendered a red `critical` "Would be refused — coverage
 * has lapsed" badge, and the table announced itself to screen readers as
 * "List of auto-renewal drafts awaiting review" over legally-final tax
 * documents.
 *
 * A review queue lists WORK ITEMS; a paid invoice is not one. Narrowing to
 * drafts fixes the false badge and the false announcement at the root, and
 * stops the queue growing monotonically as issued `auto_renewal` rows
 * accumulate. Origin remains available as a plain filter — selecting it with
 * any other status yields the ordinary list framing, which is honest.
 *
 * `showQueueActions` (invoice-table.tsx) was already correctly status-gated;
 * these predicates bring the queue CHROME (heading, caption, badge column,
 * enrichment) into line with it.
 */
import { describe, expect, it } from 'vitest';
import {
  isAutoRenewalQueueView,
  originFilterPatch,
} from '@/app/(staff)/admin/invoices/_components/queue-view';

describe('isAutoRenewalQueueView', () => {
  it('is TRUE only for origin=auto_renewal AND status=draft', () => {
    expect(isAutoRenewalQueueView({ origin: 'auto_renewal', status: 'draft' })).toBe(true);
  });

  it('is FALSE for origin=auto_renewal with a non-draft status', () => {
    // The regression this whole item exists to prevent: an issued/paid
    // §86/4 must never wear queue chrome.
    expect(isAutoRenewalQueueView({ origin: 'auto_renewal', status: 'paid' })).toBe(false);
    expect(isAutoRenewalQueueView({ origin: 'auto_renewal', status: 'issued' })).toBe(false);
  });

  it('is FALSE for origin=auto_renewal with NO status (the old mixed-status default)', () => {
    expect(isAutoRenewalQueueView({ origin: 'auto_renewal', status: undefined })).toBe(false);
  });

  it('is FALSE for a draft view that is not origin-scoped', () => {
    expect(isAutoRenewalQueueView({ origin: undefined, status: 'draft' })).toBe(false);
    expect(isAutoRenewalQueueView({ origin: 'manual', status: 'draft' })).toBe(false);
  });
});

describe('originFilterPatch', () => {
  it('selecting the auto-renewal queue ALSO pushes status=draft', () => {
    // The Origin select is the queue's only entry point — without this the
    // queue is unreachable once `isQueueView` requires drafts.
    expect(originFilterPatch('auto_renewal', null)).toEqual({
      origin: 'auto_renewal',
      status: 'draft',
    });
  });

  it('selecting the queue overrides a previously chosen status', () => {
    expect(originFilterPatch('auto_renewal', 'paid')).toEqual({
      origin: 'auto_renewal',
      status: 'draft',
    });
  });

  it('leaving the queue clears the status the queue imposed', () => {
    // Otherwise the admin is silently stuck in a drafts-only view after
    // switching back to "All origins".
    expect(originFilterPatch('all', 'draft')).toEqual({ origin: null, status: null });
    expect(originFilterPatch('manual', 'draft')).toEqual({ origin: 'manual', status: null });
  });

  it('leaving the queue PRESERVES a status the admin chose themselves', () => {
    // `draft` is the only status the queue imposes, so any other value is the
    // admin's own selection and must survive an origin change.
    expect(originFilterPatch('manual', 'paid')).toEqual({ origin: 'manual' });
    expect(originFilterPatch('all', 'issued')).toEqual({ origin: null });
  });

  it('leaves status untouched when none is set', () => {
    expect(originFilterPatch('manual', null)).toEqual({ origin: 'manual' });
  });

  it('handles the Select clearing to null the same as "all"', () => {
    // Base UI's `onValueChange` can emit null; the pre-fix inline handler
    // guarded this with `v && v !== 'all'`.
    expect(originFilterPatch(null, 'draft')).toEqual({ origin: null, status: null });
    expect(originFilterPatch(null, null)).toEqual({ origin: null });
  });
});

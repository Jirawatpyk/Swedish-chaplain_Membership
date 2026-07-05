/**
 * 090-fix-portal-receipt-download — Bug 1.
 *
 * The pay-sheet success panel's "Download receipt" link previously pointed at
 * `/portal/invoices/{id}/receipt` — a route that DOES NOT EXIST (only
 * `/portal/invoices/[invoiceId]/page.tsx` is defined), so clicking the link
 * 404'd. The correct target is the member receipt-PDF STREAMING route
 * `/api/portal/invoices/{id}/receipt/pdf` (the same route the working
 * detail-page <PortalReceiptDownloadButton> uses), which serves the §86/4 RC
 * PDF bytes so a plain `<a target="_blank">` navigation downloads/opens it.
 *
 * `buildReceiptDownloadUrl` is the single source of truth threaded into all
 * three PaySheetInternal success transitions (card submit, 3DS poll, PromptPay
 * poll). This pure test pins the resolved URL so the 404 regression can never
 * silently return — kept pure (no PaySheetInternal mount) because driving the
 * full success state needs Stripe SDK + initiate-fetch mocks.
 */
import { describe, expect, it } from 'vitest';

import { buildReceiptDownloadUrl } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-sheet-internal';

describe('buildReceiptDownloadUrl (090 Bug 1 — pay-sheet receipt link)', () => {
  it('points at the member receipt-PDF STREAMING API route', () => {
    expect(buildReceiptDownloadUrl('inv-123')).toBe(
      '/api/portal/invoices/inv-123/receipt/pdf',
    );
  });

  it('is the /api streaming route, NOT the non-existent RSC page route (the 404 regression)', () => {
    const url = buildReceiptDownloadUrl('inv-123');
    // The bug: the link went to the bare RSC path which has no route.ts.
    expect(url).not.toBe('/portal/invoices/inv-123/receipt');
    expect(url.startsWith('/api/portal/invoices/')).toBe(true);
    expect(url.endsWith('/receipt/pdf')).toBe(true);
  });

  it('encodes the invoice id into the path segment', () => {
    expect(buildReceiptDownloadUrl('abc')).toBe(
      '/api/portal/invoices/abc/receipt/pdf',
    );
  });
});

'use client';

/**
 * Spec 122 US7a (T710) — client pieces for the preview's renewals views.
 * Client-only: the mark-paid dialog takes handlers, which a server page
 * cannot pass, and the at-risk widget reads its rows in the browser. Nothing
 * here reaches the API. Every value is invented.
 */
import { useState } from 'react';
import { MarkPaidOfflineDialog } from '@/app/(staff)/admin/renewals/_components/mark-paid-offline-dialog';
import { AT_RISK_RESPONSE } from './renewal-fixtures';

const AT_RISK_PATH = '/api/admin/renewals/at-risk';

/**
 * Answers the at-risk widget's read from the fixture, filtered by the band it
 * asks for, the way the real route does. Installed at module load, before the
 * widget's first effect runs; every other request goes to the network.
 */
if (typeof window !== 'undefined') {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    );
    if (url.pathname !== AT_RISK_PATH) return realFetch(input, init);
    const band = url.searchParams.get('band');
    const body = {
      ...AT_RISK_RESPONSE,
      items: AT_RISK_RESPONSE.items.filter((row) => row.risk_score_band === band),
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
  };
}

/** Marks the at-risk fixture as in use (the module above does the work). */
export function AtRiskFixture() {
  return null;
}

/** `Admin-renewal-mark-paid`: the row's "Mark paid" dialog, opened. */
export function MarkPaidDialogPreview() {
  const [open, setOpen] = useState(true);
  return (
    <MarkPaidOfflineDialog
      cycleId="00000000-0000-4000-8000-00000000c001"
      companyName="Kiruna Mining Services (Thailand)"
      open={open}
      onOpenChange={setOpen}
    />
  );
}

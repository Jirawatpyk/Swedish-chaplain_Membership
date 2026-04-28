/**
 * Request-scoped cached wrapper around `loadInvoicePaymentActivity`
 *
 * The admin invoice detail page calls this twice per render:
 *   1. `page.tsx` to decide whether to render the Refund button
 *      (reads `computeRemainingRefundable(activity)`).
 *   2. `payment-timeline.tsx` (inside Suspense) to render the full
 *      event chain.
 *
 * React 19's `cache()` deduplicates calls with identical args within
 * the same request, so the Postgres query runs ONCE per page render
 * instead of twice. The Suspense boundary on the timeline panel is
 * preserved — both consumers receive the same in-flight Promise.
 */
import { cache } from 'react';
import {
  loadInvoicePaymentActivity,
  makeLoadInvoicePaymentActivityDeps,
  type LoadInvoicePaymentActivityOutput,
  type LoadInvoicePaymentActivityError,
} from '@/modules/payments';
import type { Result } from '@/lib/result';

export const getInvoicePaymentActivity = cache(
  async (
    tenantId: string,
    invoiceId: string,
  ): Promise<
    Result<LoadInvoicePaymentActivityOutput, LoadInvoicePaymentActivityError>
  > => {
    return loadInvoicePaymentActivity(
      makeLoadInvoicePaymentActivityDeps(tenantId),
      { tenantId, invoiceId },
    );
  },
);

/**
 * T068 — E2E: admin records payment + receipt (US2 AS1–AS4).
 *
 * Phase-4 MVP skeleton — promoted to full assertions once the seeded
 * issued-invoice fixture + PDF headless-capture configuration land.
 */
import { test } from '@playwright/test';

test.describe('@us2 record-payment', () => {
  test.fixme('AS1 admin records bank transfer → status=paid', async () => {
    // TODO(T068): seeded issued invoice + pay form fill + assert status.
  });

  test.fixme('AS2 receipt PDF downloads + bilingual content', async () => {
    // TODO(T068): assert sha256 + TH/EN label presence.
  });

  test.fixme('AS3 auto-email outbox row enqueued with receipt attachment', async () => {
    // TODO(T068): query notifications_outbox + assert event_type + pdf_blob_key.
  });

  test.fixme('AS4 partial-payment affordance is NOT present (out of MVP scope)', async () => {
    // TODO(T068): assert no "partial amount" field on the form.
  });
});

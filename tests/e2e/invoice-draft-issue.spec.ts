/**
 * T061 — E2E: admin draft → preview → issue → download (US1 AS1–AS6).
 *
 * Phase-3 MVP: skeleton test marked `.fixme` pending:
 *   - E2E seeder for a member + plan in the same tenant (T014 existing
 *     seed-f4-invoice-settings.ts covers settings; members + plan
 *     seeding on a throwaway tenant is still tracked).
 *   - Mobile-viewport block per task T061 post-analyze C4 (share-sheet
 *     download path assertion).
 *
 * Promoted to `.test` once the seeder + headless render configuration
 * lands in Phase 10 T115/T116 CI reproduction.
 *
 * Reference: spec §US1 AS1–AS6.
 */
import { test } from '@playwright/test';

test.describe('@us1 invoice draft → issue', () => {
  test.fixme('AS1 admin creates draft from member page', async () => {
    // TODO(T061): wire seeded member + plan fixture.
  });

  test.fixme('AS2 preview renders watermarked PDF, no seq consumed, no audit row', async () => {
    // TODO(T062): seeded draft + assert tenant_document_sequences unchanged.
  });

  test.fixme('AS3 issue consumes seq + commits + downloads bilingual PDF', async () => {
    // TODO(T061): typed-phrase confirmation + PDF sha256 check.
  });

  test.fixme('AS4 default list filter hides drafts; Drafts tab shows them', async () => {
    // TODO(T061): filter toggle assertion.
  });

  test.fixme('AS5 manager sees list but cannot issue (RBAC read-only)', async () => {
    // TODO(T061): sign-in-as-manager, 403 on POST.
  });

  test.fixme('AS6 member crafted URL returns 404 + cross-tenant probe audit', async () => {
    // TODO(T061): member session tries /admin/invoices/<someone-elses-id>.
  });

  test.fixme('@mobile PDF download triggers share sheet (iPhone 13)', async () => {
    // TODO(T061 post-analyze C4): devices['iPhone 13'] + Content-Disposition assertion.
  });
});

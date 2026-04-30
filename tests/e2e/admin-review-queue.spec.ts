/**
 * T099 — E2E test: admin review queue.
 *
 * Spec authority: spec.md US2 AS1–AS6.
 *
 * Flow:
 *   AS1. Admin opens /admin/broadcasts → queue lists submitted broadcasts oldest-first
 *   AS2. Admin clicks "Approve & send now" → status flips to 'approved' → cron dispatches → 'sending'
 *   AS3. Admin clicks "Reject" → reason dialog → enter reason → submit → status='rejected'; member receives email
 *   AS4. Admin clicks "Approve & schedule" → datetime-local picker → submit → status='approved' with scheduledFor
 *   AS5. Manager opens /admin/broadcasts → sees queue but no Approve/Reject/Cancel buttons
 *   AS6. Concurrent admin race: two browser tabs → both approve same broadcast → second tab gets 409 toast
 *
 * Turns GREEN: T093+T094+T100+T101+T108+T109+T110+T117+T118+T119+T123 land.
 */
import { test } from '@playwright/test';

test.describe('Admin review queue (T099 — US2 AS1–AS6)', () => {
  test.fixme('AS1: admin sees queue list ordered by submitted_at ASC', async ({ page: _page }) => {
    // Seed 3 submitted broadcasts → /admin/broadcasts → assert order
  });

  test.fixme('AS2: approve send-now → status flips to approved → cron picks up → sending', async ({ page: _page }) => {
    // Click "Approve & send now" → confirm dialog → verify status badge updates
  });

  test.fixme('AS3: reject with reason → member email + audit broadcast_rejected', async ({ page: _page }) => {
    // Click "Reject" → enter reason → submit → assert toast + status badge
  });

  test.fixme('AS4: approve & schedule with datetime → status=approved + scheduledFor set', async ({ page: _page }) => {
    // Schedule for 1 hour later → submit → verify scheduledFor cell populated
  });

  test.fixme('AS5: manager role sees queue but no action buttons', async ({ page: _page }) => {
    // Sign in as manager → /admin/broadcasts → assert <ManagerReadonlyBanner> visible
    // + no Approve/Reject/Cancel buttons rendered
  });

  test.fixme('AS6: concurrent admin race → second action gets 409 broadcast_concurrent_action_blocked toast', async ({ page: _page }) => {
    // Tab A: load queue, click Approve
    // Tab B: load queue, click Approve (race) → 409 toast + queue refreshes
  });

  test.fixme('Q14 halt-state banner: shows when ≥1 member halted', async ({ page: _page }) => {
    // Seed member with halted=true → /admin/broadcasts → assert <HaltStateBanner>
    // + click "Review + Clear halt" → typed-phrase dialog → confirm → audit emitted
  });
});

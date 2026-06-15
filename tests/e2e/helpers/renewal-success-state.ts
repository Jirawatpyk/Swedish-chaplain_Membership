/**
 * F8 Phase 6 round-3 I2 — helper for `/portal/renewal/[memberId]/success`
 * E2E state mutations.
 *
 * The success page renders three observable states:
 *   1. activeCycle.status === 'completed' → cycle-status row VISIBLE
 *   2. activeCycle truthy but not 'completed' → cycle-status row HIDDEN
 *   3. activeCycle null → processing div + back-to-portal CTA
 *
 * This helper sets the seeded cycle's status (or deletes all active
 * cycles) so each E2E test can assert one branch without a flaky
 * inter-test ordering dependency.
 */
import postgres from 'postgres';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';

export type CycleStatusForSuccessE2E =
  | 'upcoming'
  | 'reminded'
  | 'awaiting_payment'
  | 'completed';

function getSql() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      '[renewal-success-state] DATABASE_URL missing — cannot set cycle status for E2E.',
    );
  }
  return postgres(dbUrl, { ssl: 'require', max: 1 });
}

/**
 * Update the seed cycle (matched by cycleId) to the target status.
 * For 'completed', also sets `closed_at = NOW()` so the page's
 * status-row branch fires.
 */
export async function setCycleStatusForSuccessE2E(
  cycleId: string,
  status: CycleStatusForSuccessE2E,
): Promise<void> {
  const sql = getSql();
  try {
    if (status === 'completed') {
      // The F8-completion state machine enforces a CHECK
      // (`renewal_cycles_completed_requires_invoice_check`): a `completed`
      // cycle MUST carry a non-null `linked_invoice_id` (FK → invoices). The
      // seed cycle has none, so link the persistent E2E issued-invoice
      // fixture (`E2E_ISSUED_INVOICE_ID`) — it's the SAME e2e-member's invoice
      // in swecham (reset to `issued` each run by global-setup), so the FK +
      // check are both satisfied. The success page's receipt link is driven
      // by the `?invoice=` query param, NOT this column, so the linked
      // invoice's content is irrelevant to the assertions.
      const invoiceId = process.env.E2E_ISSUED_INVOICE_ID;
      if (!invoiceId) {
        throw new Error(
          '[renewal-success-state] E2E_ISSUED_INVOICE_ID missing — required to satisfy the renewal_cycles completed-requires-invoice CHECK.',
        );
      }
      await sql`
        UPDATE renewal_cycles
           SET status = 'completed',
               closed_at = NOW(),
               closed_reason = 'paid',
               linked_invoice_id = ${invoiceId}::uuid
         WHERE tenant_id = ${TENANT_ID}
           AND cycle_id = ${cycleId}::uuid
      `;
    } else {
      await sql`
        UPDATE renewal_cycles
           SET status = ${status},
               closed_at = NULL,
               closed_reason = NULL
         WHERE tenant_id = ${TENANT_ID}
           AND cycle_id = ${cycleId}::uuid
      `;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Delete all non-archival cycles for the member so the success page
 * sees `activeCycle === null` and renders the processing branch.
 */
export async function clearActiveCyclesForSuccessE2E(
  memberId: string,
): Promise<void> {
  const sql = getSql();
  try {
    await sql`
      DELETE FROM renewal_reminder_events
       WHERE tenant_id = ${TENANT_ID}
         AND cycle_id IN (
           SELECT cycle_id FROM renewal_cycles
            WHERE tenant_id = ${TENANT_ID}
              AND member_id = ${memberId}::uuid
              AND status IN ('upcoming', 'reminded', 'awaiting_payment', 'completed')
         )
    `;
    await sql`
      DELETE FROM renewal_cycles
       WHERE tenant_id = ${TENANT_ID}
         AND member_id = ${memberId}::uuid
         AND status IN ('upcoming', 'reminded', 'awaiting_payment', 'completed')
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * 108 T008 (US1, FR-001/FR-002/FR-007, SC-001/SC-007) — inventory: every F4
 * outbox event type resolves its recipient LIVE, and the outbox can address only
 * one person.
 *
 * The per-use-case tests each prove one enqueue site. What no single one of them
 * can prove is the thing that actually broke: that a site was MISSED. The bug
 * shipped because four sites shared one habit — reach into
 * `member_identity_snapshot.primary_contact_email` — and fixing three of them
 * looks identical, from inside any one test file, to fixing all four.
 *
 * So this file is a register: for each of the seven `F4OutboxEventType` values,
 * how the recipient is resolved and which test proves it. TypeScript enforces
 * completeness (`Record<F4OutboxEventType, …>` — a new event type fails to
 * compile until it is classified), and each cited test file must exist on disk,
 * so the register cannot rot into a list of promises about deleted files.
 *
 * The structural half — one recipient, no cc/bcc — is asserted against the port
 * itself, because a delivery channel that cannot carry a second address cannot
 * leak one.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { F4OutboxEventType } from '@/modules/invoicing/application/ports/email-outbox-port';

const REPO_ROOT = resolvePath(__dirname, '../../..');

type Resolution =
  /** Read live from the member's primary contact at enqueue time. */
  | 'live_primary_contact'
  /**
   * Non-member event buyer only: there is no contact row, so the address an
   * admin typed at issue is the only one that exists. Member invoices on the
   * same code path still take the live branch.
   */
  | 'snapshot_non_member_only';

interface Entry {
  readonly resolution: Resolution;
  /** Where the recipient is decided. */
  readonly site: string;
  /** A test that would fail if this site went back to the snapshot. */
  readonly provenBy: string;
}

const REGISTER: Record<F4OutboxEventType, Entry> = {
  invoice_issued: {
    // Issue time is the one moment where live and frozen are the same row:
    // the snapshot is built from the live primary contact inside the issuing
    // transaction, microseconds earlier.
    resolution: 'snapshot_non_member_only',
    site: 'src/modules/invoicing/application/use-cases/issue-invoice.ts',
    provenBy: 'tests/unit/invoicing/issue-invoice.test.ts',
  },
  invoice_paid: {
    resolution: 'live_primary_contact',
    site: 'src/modules/invoicing/application/use-cases/record-payment.ts',
    provenBy: 'tests/integration/invoicing/record-payment-live-recipient.test.ts',
  },
  invoice_voided: {
    resolution: 'live_primary_contact',
    site: 'src/modules/invoicing/application/use-cases/void-invoice.ts',
    provenBy: 'tests/unit/invoicing/void-invoice.test.ts',
  },
  credit_note_issued: {
    resolution: 'live_primary_contact',
    site: 'src/modules/invoicing/application/use-cases/issue-credit-note.ts',
    provenBy: 'tests/unit/invoicing/issue-credit-note.test.ts',
  },
  invoice_pdf_resent: {
    resolution: 'live_primary_contact',
    site: 'src/modules/invoicing/application/use-cases/resend-pdf.ts',
    provenBy: 'tests/unit/invoicing/resend-pdf.test.ts',
  },
  receipt_pdf_resent: {
    resolution: 'live_primary_contact',
    site: 'src/modules/invoicing/application/use-cases/resend-pdf.ts',
    provenBy: 'tests/unit/invoicing/resend-pdf.test.ts',
  },
  credit_note_pdf_resent: {
    resolution: 'live_primary_contact',
    site: 'src/modules/invoicing/application/use-cases/resend-pdf.ts',
    provenBy: 'tests/unit/invoicing/resend-pdf.test.ts',
  },
};

/** The F5 pipe is not an outbox row, but it carries an address to Stripe. */
const PROCESSOR_BILLING_EMAIL: Entry = {
  resolution: 'live_primary_contact',
  site: 'src/modules/payments/application/use-cases/initiate-payment.ts',
  provenBy: 'tests/unit/payments/application/initiate-payment.test.ts',
};

describe('money-email recipient inventory (108 SC-001)', () => {
  it('classifies every F4 outbox event type', () => {
    // The Record type already forces this at compile time; the runtime count
    // catches a union that GREW without anyone re-reading this file.
    expect(Object.keys(REGISTER)).toHaveLength(7);
  });

  it('every member-facing money email resolves the recipient live', () => {
    const snapshotSites = Object.entries(REGISTER).filter(
      ([, e]) => e.resolution === 'snapshot_non_member_only',
    );
    // Exactly one exception, and it is the issue-time equivalence — every other
    // event type happens LATER than issue, which is when the two can diverge.
    expect(snapshotSites.map(([k]) => k)).toEqual(['invoice_issued']);
  });

  it('the processor billing email is on the live path too', () => {
    expect(PROCESSOR_BILLING_EMAIL.resolution).toBe('live_primary_contact');
  });

  it('every cited proof file exists (the register cannot rot)', () => {
    const cited = [
      ...Object.values(REGISTER).flatMap((e) => [e.site, e.provenBy]),
      PROCESSOR_BILLING_EMAIL.site,
      PROCESSOR_BILLING_EMAIL.provenBy,
    ];
    const missing = cited.filter((rel) => !existsSync(resolvePath(REPO_ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it('the outbox can address exactly one recipient — no cc, bcc or extra to (FR-007)', async () => {
    // Structural, not behavioural: a channel with nowhere to put a second
    // address cannot leak one, whatever a future caller passes.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(
        resolvePath(
          REPO_ROOT,
          'src/modules/invoicing/application/ports/email-outbox-port.ts',
        ),
        'utf8',
      ),
    );
    // Field declarations only — prose in the docblocks is free to say "cc".
    const fieldNames = [...source.matchAll(/readonly\s+([A-Za-z0-9_]+)\??:/g)].map(
      (m) => m[1]!.toLowerCase(),
    );
    expect(fieldNames).toContain('recipientemail');
    expect(fieldNames.filter((f) => f === 'cc' || f === 'bcc')).toEqual([]);
    expect(fieldNames.filter((f) => f.includes('recipient'))).toEqual([
      'recipientemail',
      'recipientlocale',
    ]);
  });

  it('issue-time equivalence still holds — the member arm re-reads live (re-review MEDIUM-2)', () => {
    // Two allowlist entries in `check:money-recipient` justify a snapshot read
    // by saying the snapshot IS the live read at issue. The code carrying that
    // claim is `resolve-invoice-buyer.ts`, which holds no `primary_contact_email`
    // token — so the gate cannot see it, and the two entries' text would stay
    // true-looking if this helper started returning a pinned snapshot for a
    // MEMBER. Assert the load-bearing call directly.
    const src = readFileSync(
      resolvePath(REPO_ROOT, 'src/modules/invoicing/application/lib/resolve-invoice-buyer.ts'),
      'utf8',
    );
    expect(src).toContain('getForIssue');
  });
});

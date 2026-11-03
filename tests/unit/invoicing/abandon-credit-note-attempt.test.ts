/**
 * Task 68 — "Start over" on a locked admin credit-note attempt.
 *
 * After an unknown outcome the form keeps the attempt (its idempotency key)
 * locked, because the original request may still commit. Abandoning it must
 * be decided on the server, under the same invoice lock every issue attempt
 * takes: a note already issued under the key is returned instead; otherwise a
 * tombstone closes the key for good (issueCreditNote then refuses it with
 * `attempt_abandoned`), and one audit row records it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  abandonCreditNoteAttempt,
  type AbandonCreditNoteAttemptDeps,
} from '@/modules/invoicing/application/use-cases/abandon-credit-note-attempt';

const TENANT = 'test-swecham';
const INVOICE_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_INVOICE = '00000000-0000-4000-8000-0000000000a2';
const KEY = '11111111-2222-4333-8444-555555555555';
const input = { tenantId: TENANT, actorUserId: 'actor-user', requestId: 'req-1', invoiceId: INVOICE_ID, idempotencyKey: KEY };

function makeDeps(opts: {
  status?: string | null;
  note?: { creditNoteId: string; originalInvoiceId: string } | null;
  abandoned?: { invoiceId: string } | null;
}) {
  const tx = Symbol('tx');
  const deps = {
    invoiceRepo: {
      withTx: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      lockForUpdate: vi.fn(async () => (opts.status === undefined ? 'paid' : opts.status)),
    },
    creditNoteRepo: {
      findByIdempotencyKey: vi.fn(async () => opts.note ?? null),
      findAbandonedAttempt: vi.fn(async () => opts.abandoned ?? null),
      insertAbandonedAttempt: vi.fn(async () => {}),
    },
    audit: { emit: vi.fn(async () => {}) },
  };
  return { deps: deps as unknown as AbandonCreditNoteAttemptDeps, raw: deps, tx };
}

describe('abandonCreditNoteAttempt (task 68)', () => {
  it('no note under the key: locks the invoice, tombstones the key, audits once, answers abandoned', async () => {
    const { deps, raw, tx } = makeDeps({});
    const r = await abandonCreditNoteAttempt(deps, input);
    expect(r).toEqual({ ok: true, value: { outcome: 'abandoned' } });
    expect(raw.invoiceRepo.lockForUpdate).toHaveBeenCalledWith(tx, INVOICE_ID, TENANT);
    // The lock comes before the lookups.
    expect(raw.invoiceRepo.lockForUpdate.mock.invocationCallOrder[0]!).toBeLessThan(
      raw.creditNoteRepo.findByIdempotencyKey.mock.invocationCallOrder[0]!,
    );
    expect(raw.creditNoteRepo.insertAbandonedAttempt).toHaveBeenCalledWith(tx, {
      tenantId: TENANT,
      idempotencyKey: KEY,
      invoiceId: INVOICE_ID,
      abandonedByUserId: 'actor-user',
    });
    expect(raw.audit.emit).toHaveBeenCalledTimes(1);
    expect((raw.audit.emit.mock.calls[0] as unknown[])[1]).toMatchObject({
      eventType: 'credit_note_attempt_abandoned',
      actorUserId: 'actor-user',
      payload: { invoice_id: INVOICE_ID, idempotency_key: KEY },
    });
  });

  it('the note was issued under the key: answers issued with it, abandons nothing, and records the replay', async () => {
    const note = {
      creditNoteId: 'cn-1',
      originalInvoiceId: INVOICE_ID,
      documentNumber: { raw: 'CN-2026-000009' },
      total: { satang: 53_500n },
    };
    const { deps, raw, tx } = makeDeps({ note });
    const r = await abandonCreditNoteAttempt(deps, input);
    expect(r).toEqual({ ok: true, value: { outcome: 'issued', creditNote: note } });
    expect(raw.creditNoteRepo.insertAbandonedAttempt).not.toHaveBeenCalled();
    // #67 — returning an existing §86/10 note in answer to the attempt leaves
    // the same trace as a replay, in the tx that read it.
    expect(raw.audit.emit).toHaveBeenCalledTimes(1);
    expect(raw.audit.emit.mock.calls[0] as unknown[]).toEqual([
      tx,
      expect.objectContaining({
        eventType: 'credit_note_issue_replayed',
        actorUserId: 'actor-user',
        payload: {
          credit_note_id: 'cn-1',
          original_invoice_id: INVOICE_ID,
          document_number: 'CN-2026-000009',
          idempotency_key: KEY,
          total_satang: '53500',
          path: 'start_over',
        },
      }),
    ]);
  });

  it('a second Start over is idempotent: abandoned again, no second tombstone or audit', async () => {
    const { deps, raw } = makeDeps({ abandoned: { invoiceId: INVOICE_ID } });
    const r = await abandonCreditNoteAttempt(deps, input);
    expect(r).toEqual({ ok: true, value: { outcome: 'abandoned' } });
    expect(raw.creditNoteRepo.insertAbandonedAttempt).not.toHaveBeenCalled();
    expect(raw.audit.emit).not.toHaveBeenCalled();
  });

  it.each([
    ['a note on another invoice', { note: { creditNoteId: 'cn-x', originalInvoiceId: OTHER_INVOICE } }],
    ['a tombstone on another invoice', { abandoned: { invoiceId: OTHER_INVOICE } }],
  ] as const)('the key answers %s: refused as concurrent_state_change, nothing written', async (_l, opts) => {
    const { deps, raw } = makeDeps(opts);
    const r = await abandonCreditNoteAttempt(deps, input);
    expect(r).toEqual({ ok: false, error: { code: 'concurrent_state_change' } });
    expect(raw.creditNoteRepo.insertAbandonedAttempt).not.toHaveBeenCalled();
    expect(raw.audit.emit).not.toHaveBeenCalled();
  });

  it('an unknown invoice: invoice_not_found, no lookup, and a probe row that survives the tx', async () => {
    const { deps, raw } = makeDeps({ status: null });
    const r = await abandonCreditNoteAttempt(deps, { ...input, actorRole: 'admin' });
    expect(r).toEqual({ ok: false, error: { code: 'invoice_not_found' } });
    expect(raw.creditNoteRepo.findByIdempotencyKey).not.toHaveBeenCalled();
    // The same probe trace as issuing (null tx: it outlives a rollback).
    expect(raw.audit.emit.mock.calls[0] as unknown[]).toEqual([
      null,
      expect.objectContaining({
        eventType: 'credit_note_cross_tenant_probe',
        payload: { attempted_invoice_id: INVOICE_ID, actor_role: 'admin', route: 'abandon-credit-note-attempt' },
      }),
    ]);
  });

  it('the input schema refuses a malformed key or invoice id', async () => {
    const { abandonCreditNoteAttemptSchema } = await import(
      '@/modules/invoicing/application/use-cases/abandon-credit-note-attempt'
    );
    expect(abandonCreditNoteAttemptSchema.safeParse({ ...input, idempotencyKey: 'nope' }).success).toBe(false);
    expect(abandonCreditNoteAttemptSchema.safeParse({ ...input, invoiceId: 'nope' }).success).toBe(false);
    expect(abandonCreditNoteAttemptSchema.safeParse(input).success).toBe(true);
  });
});

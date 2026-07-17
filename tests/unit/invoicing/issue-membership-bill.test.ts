/**
 * 106-void-on-reissue — Task 3: `issueMembershipBill` composition.
 *
 * Composes the UNCHANGED `issueInvoice` primitive with a best-effort
 * supersede-void of the member's strictly-older, still-outstanding
 * new-flow membership bills. `issueInvoice` / `voidInvoice` are mocked at
 * the module boundary — this suite verifies ONLY the composition/orchestration
 * logic (flag gating, which bills get voided with which options, and the
 * metric-only / non-fatal failure handling), never the primitives' own
 * behaviour (covered by their own unit + integration suites).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import type { InvoiceRepo } from '@/modules/invoicing/application/ports/invoice-repo';

const issueInvoiceMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/invoicing/application/use-cases/issue-invoice', () => ({
  issueInvoice: issueInvoiceMock,
}));

const voidInvoiceMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/invoicing/application/use-cases/void-invoice', () => ({
  voidInvoice: voidInvoiceMock,
}));

import { invoicingMetrics } from '@/lib/metrics';
import {
  issueMembershipBill,
  type IssueMembershipBillDeps,
} from '@/modules/invoicing/application/use-cases/issue-membership-bill';
import type {
  IssueInvoiceDeps,
  IssueInvoiceError,
  IssueInvoiceInput,
  IssueInvoiceSuccess,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { VoidInvoiceDeps, VoidInvoiceError } from '@/modules/invoicing/application/use-cases/void-invoice';

const TENANT_ID = 't1';
const MEMBER_ID = 'mem-1';

const ISSUE_INPUT: IssueInvoiceInput = {
  tenantId: TENANT_ID,
  actorUserId: 'actor-1',
  requestId: null,
  invoiceId: 'draft-inv-1',
};

/** Minimal-but-typed IssueInvoiceSuccess fixture (mirrors the makeInvoice
 * precedent in get-invoice-for-payment.test.ts — cast to the domain type at
 * the end so only the fields THIS composition reads need be realistic). */
function makeIssued(overrides: Partial<IssueInvoiceSuccess> = {}): IssueInvoiceSuccess {
  const base = {
    tenantId: TENANT_ID,
    invoiceId: asInvoiceId('new-1'),
    invoiceSubject: 'membership',
    memberId: MEMBER_ID,
    planId: 'plan-1',
    planYear: 2026,
    eventId: null,
    eventRegistrationId: null,
    vatInclusive: false,
    status: 'issued',
    draftByUserId: 'user-1',
    fiscalYear: 2026,
    sequenceNumber: null,
    documentNumber: null,
    billDocumentNumberRaw: 'SC-2026-000001',
    issueDate: '2026-07-18',
    dueDate: '2026-08-17',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: null,
    vatRate: null,
    vat: null,
    total: null,
    creditedTotal: Money.fromSatangUnsafe(0n),
    proRatePolicy: null,
    netDays: null,
    tenantIdentitySnapshot: null,
    memberIdentitySnapshot: null,
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: null,
    pdfDocKind: 'invoice',
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [],
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    emailDispatch: 'disabled',
  };
  return { ...base, ...overrides } as IssueInvoiceSuccess;
}

const OK_ISSUED = makeIssued();

function makeDeps(opts: {
  readonly enabled: boolean;
  readonly issued?: IssueInvoiceSuccess;
  readonly issueError?: IssueInvoiceError;
  readonly olderBills?: readonly string[];
  readonly voidError?: VoidInvoiceError;
}): IssueMembershipBillDeps {
  if (opts.issueError) {
    issueInvoiceMock.mockResolvedValue(err(opts.issueError));
  } else {
    issueInvoiceMock.mockResolvedValue(ok(opts.issued ?? OK_ISSUED));
  }

  if (opts.voidError) {
    voidInvoiceMock.mockResolvedValue(err(opts.voidError));
  } else {
    voidInvoiceMock.mockResolvedValue(ok({} as Invoice));
  }

  const invoiceRepo = {
    listSupersedableMembershipBills: vi
      .fn()
      .mockResolvedValue((opts.olderBills ?? []).map((invoiceId) => ({ invoiceId }))),
  } as unknown as InvoiceRepo;

  return {
    issueDeps: {} as IssueInvoiceDeps,
    voidDeps: {} as VoidInvoiceDeps,
    invoiceRepo,
    voidOnReissueEnabled: opts.enabled,
  };
}

describe('issueMembershipBill', () => {
  let metricSpy: { voidOnReissueFailed: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    issueInvoiceMock.mockReset();
    voidInvoiceMock.mockReset();
    metricSpy = {
      voidOnReissueFailed: vi.spyOn(invoicingMetrics, 'voidOnReissueFailed'),
    };
  });

  afterEach(() => {
    metricSpy.voidOnReissueFailed.mockRestore();
  });

  it('flag OFF → plain issue, no supersede, empty warnings', async () => {
    const deps = makeDeps({ enabled: false, issued: OK_ISSUED, olderBills: ['old-1'] });
    const res = await issueMembershipBill(deps, ISSUE_INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.supersedeWarnings).toEqual([]);
    expect(voidInvoiceMock).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.listSupersedableMembershipBills).not.toHaveBeenCalled();
  });

  it('flag ON → voids each strictly-older bill with requireStatus + suppress + supersededByInvoiceId', async () => {
    const deps = makeDeps({
      enabled: true,
      issued: OK_ISSUED /* id:new-1 */,
      olderBills: ['old-1', 'old-2'],
    });
    const res = await issueMembershipBill(deps, ISSUE_INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.supersedeWarnings).toEqual([]);
    expect(voidInvoiceMock).toHaveBeenCalledTimes(2);
    expect(voidInvoiceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        invoiceId: 'old-1',
        requireStatus: 'issued',
        suppressCancellationEmail: true,
        supersededByInvoiceId: 'new-1',
      }),
    );
    expect(deps.invoiceRepo.listSupersedableMembershipBills).toHaveBeenCalledWith(
      TENANT_ID,
      MEMBER_ID,
      expect.objectContaining({
        excludeInvoiceId: 'new-1',
        invoiceId: 'new-1',
        createdAt: expect.any(Date),
      }),
    );
  });

  it('issue fails → returns the issue error, never lists/voids', async () => {
    const deps = makeDeps({
      enabled: true,
      issueError: { code: 'invoice_already_issued', status: 'draft' },
    });
    const res = await issueMembershipBill(deps, ISSUE_INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invoice_already_issued');
    expect(voidInvoiceMock).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.listSupersedableMembershipBills).not.toHaveBeenCalled();
  });

  it('a void failure is non-fatal: issue still returns ok + warning + metric', async () => {
    const deps = makeDeps({
      enabled: true,
      issued: OK_ISSUED,
      olderBills: ['old-1'],
      voidError: { code: 'concurrent_state_change' },
    });
    const res = await issueMembershipBill(deps, ISSUE_INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.supersedeWarnings).toHaveLength(1);
    expect(metricSpy.voidOnReissueFailed).toHaveBeenCalledWith('t1');
  });

  it('invalid_status void (already void / raced to paid) is swallowed as no-op, no warning', async () => {
    const deps = makeDeps({
      enabled: true,
      issued: OK_ISSUED,
      olderBills: ['old-1'],
      voidError: { code: 'invalid_status', status: 'paid' },
    });
    const res = await issueMembershipBill(deps, ISSUE_INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.supersedeWarnings).toEqual([]); // invalid_status = expected no-op
    expect(metricSpy.voidOnReissueFailed).not.toHaveBeenCalled();
  });

  it('a THROWN void error is non-fatal: issue still returns ok + warning + metric (symmetric with the returned-error case)', async () => {
    const deps = makeDeps({ enabled: true, issued: OK_ISSUED, olderBills: ['old-1'] });
    voidInvoiceMock.mockRejectedValue(new Error('infra'));
    const res = await issueMembershipBill(deps, ISSUE_INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.supersedeWarnings).toHaveLength(1);
    expect(metricSpy.voidOnReissueFailed).toHaveBeenCalledWith('t1');
  });

  it('memberId null → never lists/voids, empty warnings (defence-in-depth guard)', async () => {
    const deps = makeDeps({
      enabled: true,
      issued: makeIssued({ memberId: null }),
      olderBills: ['old-1'],
    });
    const res = await issueMembershipBill(deps, ISSUE_INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.supersedeWarnings).toEqual([]);
    expect(deps.invoiceRepo.listSupersedableMembershipBills).not.toHaveBeenCalled();
    expect(voidInvoiceMock).not.toHaveBeenCalled();
  });
});

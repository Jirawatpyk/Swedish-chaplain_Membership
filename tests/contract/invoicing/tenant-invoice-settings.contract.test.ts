/**
 * 088-invoice-tax-flow-redesign — T037 [US5] Contract test for
 * PATCH /api/tenant-invoice-settings per
 * `specs/088-invoice-tax-flow-redesign/contracts/tenant-invoice-settings.md`.
 *
 * Part A — HTTP route contract (mocked seams, REAL bodySchema):
 *   - 200 accepts the US5 fields (wht_note_th/_en, seller_is_head_office +
 *     seller_branch_code, the FR-022 bank block) → they thread into the
 *     use-case input (camelCase).
 *   - 400 invalid_body: `receipt_numbering_mode: 'combined'` is REJECTED
 *     (combined retired, fail-closed — F.5).
 *   - 400 invalid_body: seller-branch pairing (head-office=false with no code,
 *     or head-office=true WITH a code).
 *   - 400 invalid_body: malformed SWIFT / account-no.
 *   - 401/403 forwarded from requireAdminContext (admin-only write).
 *
 * Part B — use-case contract (REAL updateTenantInvoiceSettings, mocked ports):
 *   - the new fields land in the repo `upsert` patch;
 *   - `tenant_invoice_settings_updated` audit fires in the same tx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const updateTenantInvoiceSettingsMock = vi.fn();
const makeDepsMock = vi.fn((..._args: unknown[]) => ({}));

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-settings-1',
}));

vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async (..._args: unknown[]) => ({
      success: true,
      reset: Date.now() + 60_000,
    })),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Keep the REAL env (the invoicing barrel reads env at import) but pin the
// deployed tenant slug so the dual-bind probe does not 403 our test request.
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      tenant: { ...actual.env.tenant, slug: 'test-swecham', xHeaderEnabled: false },
    },
  };
});

vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    updateTenantInvoiceSettings: (...args: unknown[]) =>
      updateTenantInvoiceSettingsMock(...args),
    makeUpdateTenantInvoiceSettingsDeps: (...args: unknown[]) => makeDepsMock(...args),
  };
});

// Import the route ONCE (statically). vitest hoists the vi.mock() calls above
// this import, so the route still binds the mocked seams. Importing per-`it` via
// `await import()` pulled the heavy invoicing barrel graph inside each timed test
// body (~9s cold) — fine alone, but it exceeded the 30s per-test budget under
// full-suite load and cascaded into mock pollution in the next test. One static
// import moves that cost to module-load (collect) and keeps each `it` fast.
import { PATCH } from '@/app/api/tenant-invoice-settings/route';

const adminContext = {
  current: {
    user: {
      id: 'admin-user-1',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin User',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-settings-1',
};

function patchRequest(body: unknown): NextRequest {
  return new NextRequest('https://swecham.zyncdata.app/api/tenant-invoice-settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('088 US5 T037 — PATCH /api/tenant-invoice-settings route contract', () => {
  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
    updateTenantInvoiceSettingsMock.mockResolvedValue({ ok: true, value: undefined });
  });
  afterEach(() => vi.clearAllMocks());

  it('200 — accepts the US5 fields and threads them (camelCase) into the use-case', async () => {
    const res = await PATCH(
      patchRequest({
        wht_note_th: 'ยกเว้นภาษี ณ ที่จ่าย',
        wht_note_en: 'No withholding tax applies.',
        seller_is_head_office: false,
        seller_branch_code: '00001',
        bank_payee_name: 'Thai-Swedish Chamber of Commerce',
        bank_account_no: '005-3-92003-9',
        bank_account_type: 'Savings',
        bank_name: 'Kasikorn Bank',
        bank_branch: 'Emquartier',
        bank_address: 'Sukhumvit 35, Bangkok',
        bank_swift: 'KASITHBK',
        payment_instructions_th: 'ขีดคร่อม A/C Payee Only',
        payment_instructions_en: 'Account Payee Only.',
      }),
    );
    expect(res.status).toBe(200);
    expect(updateTenantInvoiceSettingsMock).toHaveBeenCalledTimes(1);
    const input = updateTenantInvoiceSettingsMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.whtNoteTh).toBe('ยกเว้นภาษี ณ ที่จ่าย');
    expect(input.whtNoteEn).toBe('No withholding tax applies.');
    expect(input.sellerIsHeadOffice).toBe(false);
    expect(input.sellerBranchCode).toBe('00001');
    expect(input.bankPayeeName).toBe('Thai-Swedish Chamber of Commerce');
    expect(input.bankAccountNo).toBe('005-3-92003-9');
    expect(input.bankAccountType).toBe('Savings');
    expect(input.bankName).toBe('Kasikorn Bank');
    expect(input.bankBranch).toBe('Emquartier');
    expect(input.bankAddress).toBe('Sukhumvit 35, Bangkok');
    expect(input.bankSwift).toBe('KASITHBK');
    expect(input.paymentInstructionsTh).toBe('ขีดคร่อม A/C Payee Only');
    expect(input.paymentInstructionsEn).toBe('Account Payee Only.');
  });

  it('200 — null clears the WHT note + bank fields', async () => {
    const res = await PATCH(
      patchRequest({ wht_note_th: null, wht_note_en: null, bank_account_no: null }),
    );
    expect(res.status).toBe(200);
    const input = updateTenantInvoiceSettingsMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.whtNoteTh).toBeNull();
    expect(input.whtNoteEn).toBeNull();
    expect(input.bankAccountNo).toBeNull();
  });

  it("400 invalid_body — receipt_numbering_mode 'combined' is rejected (retired)", async () => {
    const res = await PATCH(patchRequest({ receipt_numbering_mode: 'combined' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(updateTenantInvoiceSettingsMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — seller_is_head_office=false with no branch code', async () => {
    const res = await PATCH(patchRequest({ seller_is_head_office: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(updateTenantInvoiceSettingsMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — seller_is_head_office=true WITH a branch code', async () => {
    const res = await PATCH(
      patchRequest({ seller_is_head_office: true, seller_branch_code: '00042' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('400 invalid_body — malformed SWIFT / account-no', async () => {
    const bad1 = await PATCH(patchRequest({ bank_swift: 'nope' }));
    expect(bad1.status).toBe(400);
    const bad2 = await PATCH(patchRequest({ bank_account_no: 'no!' }));
    expect(bad2.status).toBe(400);
  });

  it('403 — non-admin is rejected (requireAdminContext forwards the response)', async () => {
    const { NextResponse } = await import('next/server');
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 }),
    });
    const res = await PATCH(patchRequest({ wht_note_en: 'x' }));
    expect(res.status).toBe(403);
    expect(updateTenantInvoiceSettingsMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Part B — use-case contract (REAL use-case, mocked ports).
// ---------------------------------------------------------------------------

describe('088 US5 T037 — updateTenantInvoiceSettings use-case contract', () => {
  it('threads the new fields into the repo patch + emits tenant_invoice_settings_updated', async () => {
    const { updateTenantInvoiceSettings } = await vi.importActual<
      typeof import('@/modules/invoicing/application/use-cases/update-tenant-invoice-settings')
    >('@/modules/invoicing/application/use-cases/update-tenant-invoice-settings');

    let capturedPatch: Record<string, unknown> | null = null;
    const auditEvents: Array<{ eventType: string }> = [];

    const repo = {
      getForIssue: vi.fn(),
      getForUpdateInTx: vi.fn(async () => null), // bootstrap → no prefix-change event
      readSequencesInTx: vi.fn(async () => []),
      upsert: vi.fn(async (_tenantId: string, patch: Record<string, unknown>) => {
        capturedPatch = patch;
      }),
      withTx: vi.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({}),
      ),
    };
    const audit = {
      emit: vi.fn(async (_tx: unknown, ev: { eventType: string }) => {
        auditEvents.push({ eventType: ev.eventType });
      }),
    };

    const result = await updateTenantInvoiceSettings(
      { tenantSettingsRepo: repo as never, audit: audit as never },
      {
        tenantId: 'test-swecham',
        actorUserId: 'admin-user-1',
        requestId: 'req-settings-1',
        whtNoteTh: 'ยกเว้นภาษี',
        whtNoteEn: 'exempt',
        sellerIsHeadOffice: true,
        sellerBranchCode: null,
        bankPayeeName: 'TSCC',
        bankAccountNo: '005-3-92003-9',
        bankSwift: 'KASITHBK',
        paymentInstructionsEn: 'Account Payee Only',
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedPatch).not.toBeNull();
    expect(capturedPatch!.whtNoteTh).toBe('ยกเว้นภาษี');
    expect(capturedPatch!.whtNoteEn).toBe('exempt');
    expect(capturedPatch!.sellerIsHeadOffice).toBe(true);
    expect(capturedPatch!.sellerBranchCode).toBeNull();
    expect(capturedPatch!.bankPayeeName).toBe('TSCC');
    expect(capturedPatch!.bankAccountNo).toBe('005-3-92003-9');
    expect(capturedPatch!.bankSwift).toBe('KASITHBK');
    expect(capturedPatch!.paymentInstructionsEn).toBe('Account Payee Only');
    expect(auditEvents.map((e) => e.eventType)).toContain('tenant_invoice_settings_updated');
  });
});

/**
 * T102 — Integration test: inline edit use case.
 *
 * Tests the inline-edit whitelisted-field update + rollback semantics.
 * Uses stubbed deps (no live DB) for the Application-layer logic validation.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  inlineEdit,
  INLINE_EDIT_FIELDS,
  type InlineEditDeps,
  type InlineEditMeta,
} from '@/modules/members/application/use-cases/inline-edit';
import type { MemberId } from '@/modules/members';

const memberId = '11111111-2222-3333-4444-555555555555' as MemberId;
const meta: InlineEditMeta = {
  actorUserId: 'admin-1',
  requestId: 'req-inline-1',
};

const stubMember = {
  tenantId: 'test-tenant',
  memberId,
  companyName: 'Test Corp',
  legalEntityType: null,
  country: 'TH',
  taxId: null,
  website: null,
  description: null,
  foundedYear: null,
  turnoverThb: null,
  planId: 'plan-1',
  planYear: 2026,
  registrationDate: new Date('2026-01-01'),
  registrationFeePaid: false,
  lastActivityAt: null,
  notes: null,
  status: 'active' as const,
  archivedAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

function stubDeps(overrides?: Partial<InlineEditDeps>): InlineEditDeps {
  return {
    tenant: { slug: 'test-tenant' } as InlineEditDeps['tenant'],
    memberRepo: {
      findById: vi.fn().mockResolvedValue(ok(stubMember)),
      findSoftDuplicate: vi.fn(),
      createWithPrimaryContact: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(ok({ ...stubMember, status: 'inactive' })),
      updateFields: vi.fn(),
      updateFieldsInTx: vi.fn().mockResolvedValue(ok({ ...stubMember, notes: 'updated' })),
      searchDirectory: vi.fn(),
    },
    audit: {
      record: vi.fn().mockResolvedValue(ok(undefined)),
      recordInTx: vi.fn().mockResolvedValue(ok(undefined)),
    },
    clock: { now: () => new Date('2026-04-16T10:00:00Z') },
    ...overrides,
  };
}

describe('integration: inline edit (T102)', () => {
  it('rejects non-whitelisted field', async () => {
    const deps = stubDeps();
    const result = await inlineEdit(
      memberId,
      { field: 'plan_id', value: 'some-plan' },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
  });

  it('rejects invalid status value for inline edit', async () => {
    const deps = stubDeps();
    const result = await inlineEdit(
      memberId,
      { field: 'status', value: 'archived' },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_field_value');
    }
  });

  it('rejects empty country', async () => {
    const deps = stubDeps();
    const result = await inlineEdit(
      memberId,
      { field: 'country', value: '' },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_field_value');
    }
  });

  it('rejects notes exceeding 4000 chars', async () => {
    const deps = stubDeps();
    const result = await inlineEdit(
      memberId,
      { field: 'notes', value: 'x'.repeat(4001) },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_field_value');
    }
  });

  it('no-op when country is unchanged', async () => {
    const deps = stubDeps();
    const result = await inlineEdit(
      memberId,
      { field: 'country', value: 'TH' },
      meta,
      deps,
    );
    // Returns current member unchanged (no DB write)
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.country).toBe('TH');
    }
    // No DB write calls
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('no-op when notes is unchanged', async () => {
    const deps = stubDeps();
    const result = await inlineEdit(
      memberId,
      { field: 'notes', value: null },
      meta,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('returns not_found when member does not exist', async () => {
    const deps = stubDeps({
      memberRepo: {
        ...stubDeps().memberRepo,
        findById: vi.fn().mockResolvedValue(err({ code: 'repo.not_found' })),
      } as InlineEditDeps['memberRepo'],
    });
    const result = await inlineEdit(
      memberId,
      { field: 'status', value: 'inactive' },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('not_found');
    }
  });

  it('rejects status change on archived member', async () => {
    const deps = stubDeps({
      memberRepo: {
        ...stubDeps().memberRepo,
        findById: vi.fn().mockResolvedValue(
          ok({ ...stubMember, status: 'archived', archivedAt: new Date('2026-04-01') }),
        ),
      } as InlineEditDeps['memberRepo'],
    });
    const result = await inlineEdit(
      memberId,
      { field: 'status', value: 'active' },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('state_error');
    }
  });

  it('allows all whitelisted fields', () => {
    expect(INLINE_EDIT_FIELDS).toEqual(['status', 'country', 'notes']);
  });
});

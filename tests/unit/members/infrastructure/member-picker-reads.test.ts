/**
 * #89 — the two slim member reads behind the invoice pickers:
 * - `memberPickerOptionsInTx`: the /admin/invoices/new preload. It selects the
 *   four fields the picker uses, never the full member or contact rows that
 *   `directorySearch` brings.
 * - `memberCompanyNamesByIdsInTx`: the invoices list's buyer-name fallback, by
 *   id, so it is not capped at the directory's first 100.
 *
 * Every statement carries an explicit `tenant_id` predicate (D-029).
 */
import { describe, expect, it } from 'vitest';
import {
  SHAPE_TENANT as T,
  recordingDb,
  tenantPredicateViolations,
  tenantScopedTables,
} from '../../../helpers/tenant-sql-shape';
import {
  memberCompanyNamesByIdsInTx,
  memberPickerOptionsInTx,
} from '@/modules/members/infrastructure/db/member-picker-reads';

const TABLES = tenantScopedTables();

describe('memberPickerOptionsInTx', () => {
  it('reads only the picker fields, fenced to the tenant, active and inactive, not erased', async () => {
    const r = recordingDb();
    await memberPickerOptionsInTx(r.db as never, T, { statuses: ['active', 'inactive'], limit: 100 });
    expect(r.statements).toHaveLength(1);
    const s = r.statements[0]!;
    expect(tenantPredicateViolations(s, TABLES).violations).toEqual([]);
    expect(s.sql).not.toMatch(/"contacts"/);
    const selected = s.sql.slice(0, s.sql.indexOf(' from '));
    expect(selected).toMatch(/"member_id"/);
    expect(selected).toMatch(/"company_name"/);
    expect(selected).toMatch(/"plan_id"/);
    expect(selected).toMatch(/"plan_year"/);
    expect(selected).not.toMatch(/tax_id|email|phone|address/);
    expect(s.sql).toMatch(/"erased_at" is null/);
    expect(s.params).toEqual(expect.arrayContaining(['active', 'inactive']));
  });

  it('clamps the limit to 1..100', async () => {
    const r = recordingDb();
    await memberPickerOptionsInTx(r.db as never, T, { statuses: ['active'], limit: 500 });
    await memberPickerOptionsInTx(r.db as never, T, { statuses: ['active'], limit: 0 });
    expect(r.statements[0]!.params).toContain(100);
    expect(r.statements[1]!.params).toContain(1);
  });
});

it('memberPickerOptionsInTx: no statuses is no members, never every status (fail closed)', async () => {
  const r = recordingDb();
  expect(await memberPickerOptionsInTx(r.db as never, T, { statuses: [], limit: 100 })).toEqual([]);
  expect(r.statements).toHaveLength(0);
});

describe('memberCompanyNamesByIdsInTx', () => {
  it('reads company names by id, fenced to the tenant, not erased', async () => {
    const r = recordingDb();
    const out = await memberCompanyNamesByIdsInTx(r.db as never, T, ['m-1', 'm-2']);
    expect(out.size).toBe(0);
    expect(r.statements).toHaveLength(1);
    const s = r.statements[0]!;
    expect(tenantPredicateViolations(s, TABLES).violations).toEqual([]);
    expect(s.params).toEqual(expect.arrayContaining(['m-1', 'm-2']));
    expect(s.sql).toMatch(/"erased_at" is null/);
    expect(s.sql.slice(0, s.sql.indexOf(' from '))).not.toMatch(/tax_id|email/);
  });

  it('sends no query for no ids', async () => {
    const r = recordingDb();
    const out = await memberCompanyNamesByIdsInTx(r.db as never, T, []);
    expect(out.size).toBe(0);
    expect(r.statements).toHaveLength(0);
  });
});

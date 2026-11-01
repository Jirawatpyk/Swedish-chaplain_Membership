/**
 * Spec 140 s2b — the SQL every lease-fenced writer sends, read off a real
 * Drizzle instance over the `pg-proxy` driver (the exact text and parameters
 * the adapter would send to Neon).
 *
 * Each of the ten writers that takes `lease: LeaseToken | null` must, when
 * handed a token, carry BOTH fences on its UPDATE: the tenant
 * (`"broadcasts"."tenant_id" = $n`, bound to the tenant) and the token
 * (`"broadcasts"."dispatch_lease_token" = $m`, bound to the token). With
 * `null` (a non-holder) the token predicate is absent. What the database does
 * with them is proven on live Neon in `dispatch-lease-repo.test.ts`.
 *
 * Positive control (rules.md: a source-parsing gate must fail when its parse
 * yields nothing): the set of writers below is checked against the repo
 * SOURCE — every method whose parameter list declares
 * `lease: LeaseToken | null,` (matched with `\r?\n`, so a CRLF checkout
 * parses too) — so a new fenced writer that this list misses, or a parse that
 * finds none, turns this red.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import type { LeaseToken } from '@/modules/broadcasts/application/ports/broadcasts-repo';

const SRC = 'src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts';
const TENANT = 'tenant-lease-shape';
const ID = asBroadcastId('7f3c1a52-0000-4000-8000-0000000000f2');
const TOKEN = 'cccccccc-0000-4000-8000-00000000000c' as LeaseToken;
const AT = new Date('2026-11-01T03:00:00.000Z');

interface Sent {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A recording tx: answers the tenant probe, matches every UPDATE (one row), and records everything. */
function recordingTx(): { tx: unknown; sent: Sent[] } {
  const sent: Sent[] = [];
  const tx = drizzle(async (sqlText, params) => {
    sent.push({ sql: sqlText, params });
    if (sqlText.includes("current_setting('app.current_tenant'")) return { rows: [{ current_tenant: TENANT }] };
    // One matched row, so no writer takes its 0-row probe branch.
    if (/\breturning\b/i.test(sqlText)) return { rows: [[ID]] };
    return { rows: [] };
  });
  return { tx, sent };
}

type Call = (repo: ReturnType<typeof makeDrizzleBroadcastsRepo>, tx: unknown, lease: LeaseToken | null) => Promise<unknown>;

/** The ten fenced writers (A3) and a call that reaches each one's UPDATE. */
const WRITERS: Readonly<Record<string, Call>> = {
  applyTransition: (r, tx, lease) => r.applyTransition(tx, TENANT as never, ID, 'sending', { sendingStartedAt: AT }, 'approved', lease),
  attachResendIds: (r, tx, lease) => r.attachResendIds(tx, TENANT as never, ID, 'aud-1', 'rb-1', lease),
  attachAudienceId: (r, tx, lease) => r.attachAudienceId(tx, TENANT as never, ID, 'aud-1', lease),
  attachBroadcastId: (r, tx, lease) => r.attachBroadcastId(tx, TENANT as never, ID, 'rb-1', lease),
  attachAudienceImport: (r, tx, lease) =>
    r.attachAudienceImport(tx, TENANT as never, ID, 'imp-1', lease, { expectedResendAudienceId: 'aud-1' }),
  markDispatchRetryStarted: (r, tx, lease) => r.markDispatchRetryStarted(tx, TENANT as never, ID, AT, lease),
  clearDispatchRetryClock: (r, tx, lease) => r.clearDispatchRetryClock(tx, TENANT as never, ID, lease),
  releaseAudienceImport: (r, tx, lease) =>
    r.releaseAudienceImport(tx, TENANT as never, ID, { importId: 'imp-1', resendAudienceId: 'aud-1', resendBroadcastId: null }, lease),
  releaseResendAudience: (r, tx, lease) =>
    r.releaseResendAudience(tx, TENANT as never, ID, { resendAudienceId: 'aud-1', resendBroadcastId: null }, lease),
  markAudienceImportCompleted: (r, tx, lease) => r.markAudienceImportCompleted(tx, TENANT as never, ID, lease),
};

/** The methods in the repo source whose parameter list declares `lease: LeaseToken | null,`. */
function fencedWritersInSource(): string[] {
  const src = readFileSync(SRC, 'utf8');
  const names: string[] = [];
  // One chunk per method of the factory object (`    async name(`).
  for (const chunk of src.split(/\r?\n {4}async /).slice(1)) {
    const header = chunk.slice(0, chunk.search(/\)\s*(?::\s*Promise<[^>]+>)?\s*\{/) + 1);
    const name = /^(\w+)\(/.exec(chunk)?.[1];
    if (name !== undefined && /lease: LeaseToken \| null,\r?\n/.test(header)) names.push(name);
  }
  return names.sort();
}

function theUpdate(sent: readonly Sent[]): Sent {
  const update = sent.find((s) => /^update "broadcasts"/i.test(s.sql));
  expect(update, 'no UPDATE on broadcasts was sent').toBeDefined();
  return update as Sent;
}

function whereOf(sqlText: string): string {
  return sqlText.slice(sqlText.search(/\bwhere\b/i));
}

/** The `$n` bound to `value` in a predicate `"broadcasts"."<col>" = $n`, or null. */
function boundTo(update: Sent, column: string): unknown {
  const m = new RegExp(`"broadcasts"\\."${column}"\\s*=\\s*\\$(\\d+)`).exec(whereOf(update.sql));
  return m === null ? undefined : update.params[Number(m[1]) - 1];
}

describe('spec 140 s2b — tenant + token on every fenced writer (SQL shape)', () => {
  it('positive control: the source declares exactly these ten fenced writers (the parse is not empty)', () => {
    const found = fencedWritersInSource();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(Object.keys(WRITERS).sort());
  });

  it.each(Object.entries(WRITERS))('%s — with a token the UPDATE carries tenant_id AND dispatch_lease_token, each bound', async (_name, call) => {
    const { tx, sent } = recordingTx();
    await call(makeDrizzleBroadcastsRepo(TENANT), tx, TOKEN).catch(() => undefined);
    const update = theUpdate(sent);
    expect(boundTo(update, 'tenant_id')).toBe(TENANT);
    expect(boundTo(update, 'dispatch_lease_token')).toBe(TOKEN);
  });

  it.each(Object.entries(WRITERS))('%s — with null (a non-holder) the UPDATE has no token predicate', async (_name, call) => {
    const { tx, sent } = recordingTx();
    await call(makeDrizzleBroadcastsRepo(TENANT), tx, null).catch(() => undefined);
    const update = theUpdate(sent);
    expect(boundTo(update, 'tenant_id')).toBe(TENANT);
    expect(whereOf(update.sql)).not.toMatch(/"dispatch_lease_token"\s*=/);
  });
});

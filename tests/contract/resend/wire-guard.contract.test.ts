// @vitest-environment node
/**
 * Spec 140 s4, DR4 — "The broadcasts contract suite passes. It fails on any
 * `DELETE /contacts/{email}`, so an account-wide contact delete cannot ship."
 *
 * The guard lives in `tests/support/resend/wire-guard.ts`; `stubWire` and every
 * unit file that stubs `fetch` under the Resend gateway install it. It RECORDS
 * a violation rather than throwing, because the SDK's `fetchRequest` catches a
 * throw from `fetch` and returns `application_error`, which would hide it; the
 * default `stubWire` then fails the test from `onTestFinished`.
 *
 * This file is the positive control. The record-only cases drive the REAL SDK
 * (`contacts.remove({ email })` with no segment is exactly the account-wide
 * DELETE) and the stubbed `fetch` directly, so they can assert what the guard
 * recorded; the `it.fails` case proves that the default `stubWire` fails the
 * test it ran in.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Resend } from 'resend';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  delete process.env['RESEND_BASE_URL'];
  delete process.env['RESEND_USER_AGENT'];
});
import { json, stubWire, stubWireRecordOnly } from './_wire';

const SEGMENT = '0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19';
const CONTACT_ID = '479e3145-dd38-476b-932c-529ceb705947';
const ok = () => json(200, { object: 'contact', deleted: true });

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the DR4 wire guard (spec 140 s4)', () => {
  it('the wire guard fails a DELETE /contacts/{email}: the real SDK call is recorded', async () => {
    const { calls, violations } = stubWireRecordOnly(ok);
    await new Resend('re_test').contacts.remove({ email: 'x@resend.dev' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['DELETE https://api.resend.com/contacts/x@resend.dev']);
    expect(violations).toEqual([{ method: 'DELETE', url: 'https://api.resend.com/contacts/x@resend.dev' }]);
  });

  // The mutants: each spelling of the same account-wide delete is recorded,
  // on any host.
  it.each([
    ['a trailing slash', () => fetch('https://api.resend.com/contacts/x@resend.dev/', { method: 'DELETE' })],
    ['a query string', () => fetch('https://api.resend.com/contacts/x@resend.dev?x=1', { method: 'DELETE' })],
    ['an uppercase /Contacts/', () => fetch('https://api.resend.com/Contacts/x@resend.dev', { method: 'DELETE' })],
    ['a lowercase method', () => fetch('https://api.resend.com/contacts/x@resend.dev', { method: 'delete' })],
    ['a doubled leading slash', () => fetch('https://api.resend.com//contacts/x@resend.dev', { method: 'DELETE' })],
    ['another host', () => fetch('https://proxy.example/contacts/x@resend.dev', { method: 'DELETE' })],
    ['a Request object', () => fetch(new Request('https://api.resend.com/contacts/x@resend.dev', { method: 'DELETE' }))],
    ['a URL object', () => fetch(new URL('https://api.resend.com/contacts/x@resend.dev'), { method: 'DELETE' })],
    ['by contact id', () => fetch(`https://api.resend.com/contacts/${CONTACT_ID}`, { method: 'DELETE' })],
  ])('records %s', async (_label, send) => {
    const { violations } = stubWireRecordOnly(ok);
    await send();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.method).toBe('DELETE');
  });

  // What the gateway does send, and the neighbours of the forbidden shape: none
  // is recorded.
  it.each([
    ['the segment detach', () => new Resend('re_test').contacts.segments.remove({ email: 'x@resend.dev', segmentId: SEGMENT })],
    ['a contact GET', () => fetch('https://api.resend.com/contacts/x@resend.dev')],
    ['a segment DELETE', () => new Resend('re_test').segments.remove(SEGMENT)],
    ['a broadcast DELETE', () => fetch('https://api.resend.com/broadcasts/bc_1', { method: 'DELETE' })],
    ['a contact PATCH', () => fetch('https://api.resend.com/contacts/x@resend.dev', { method: 'PATCH' })],
  ])('does not record %s', async (_label, send) => {
    const { calls, violations } = stubWireRecordOnly(ok);
    await send();
    expect(calls).toHaveLength(1);
    expect(violations).toEqual([]);
  });

  // The default `stubWire` fails the test a violation happened in, from
  // `onTestFinished` (which runs after `afterEach`, so `unstubAllGlobals` cannot
  // drop it). The body itself cannot fail: the SDK answers a value, never a
  // throw, so the only thing that can fail this test is the guard, and
  // `it.fails` passes only if it does. The record-only case above pins that the
  // same call is recorded.
  it.fails('the default stubWire fails the test that sent DELETE /contacts/{email}', async () => {
    stubWire(ok);
    await new Resend('re_test').contacts.remove({ email: 'x@resend.dev' });
  });

  it('the default stubWire leaves a test that sent nothing forbidden green', async () => {
    const calls = stubWire(() => json(200, { object: 'contact_segment', deleted: true }));
    await new Resend('re_test').contacts.segments.remove({ email: 'x@resend.dev', segmentId: SEGMENT });
    expect(calls).toHaveLength(1);
  });
});

/**
 * PR #756 review rounds 1 to 3 (security L1, M1; code-review #7) — the runtime
 * guard above sees only what a test drives. This reads SOURCE, so an
 * account-wide contact delete cannot ship on a path no test reaches.
 * Structural, not method-aware:
 *
 *   - over EVERY file under `src/`: the SDK's `contacts.remove(` in every
 *     spelling the pattern can see (`contacts.remove (`, `contacts?.remove(`,
 *     `contacts ["remove"]`, `contacts?.['remove']`);
 *   - over every file that imports `resend`, `resend-broadcasts-client` or
 *     `resend-api-base-url` (the files that can reach the Resend API): any raw
 *     `fetch(` / `importFetch(` / `.delete(` / `['delete'](` call, with or
 *     without a type argument, whose path literal holds `/contacts/${`,
 *     whatever method it sends (`/contacts/imports` and
 *     `/contacts/imports/${id}` never contain `/contacts/${`, so they pass);
 *     and any string literal ending in `/contacts/` that is concatenated (`+`).
 *
 * The segment detach goes through `contacts.segments.remove(`, which the
 * positive controls require exactly once in the gateway.
 *
 * STILL OUT OF REACH of a source scan, stated rather than implied: a
 * destructured method (`const { remove } = sdk.contacts; remove(...)`), an
 * aliased contacts object (`const c = sdk.contacts; c.remove(...)`), a path
 * held in a variable (`const p = '/contacts/' + e; fetch(p)` passes the concat
 * pattern only if the literal and the `+` sit together, and `fetch(p)` alone
 * says nothing), a `new URL(...)` argument, a path built by `[...].join('/')` or
 * a helper, a dynamic `import('resend')` (the importer filter reads static
 * `from` / `require` only), a re-export through a barrel (a file that takes the
 * SDK or the client from a local barrel is not in the raw-path set), and a file
 * that reaches Resend without importing any of the three modules above (a raw
 * fetch to `api.resend.com`). The runtime wire guard
 * (`tests/support/resend/wire-guard.ts`) covers only part of that: it fails a
 * `DELETE /contacts/{email}` on a path a test drives with a stubbed `fetch`, and
 * sees nothing a test never runs. `\s` spans `\r\n`, so the scan holds on a CRLF
 * checkout.
 */
describe('the DR4 source gate on src (spec 140 s4)', () => {
  const GATEWAY = join('src', 'modules', 'broadcasts', 'infrastructure', 'resend', 'resend-broadcasts-gateway.ts');
  const RAW_CONTACT_PATH =
    /(?:importFetch|fetch|\.delete|\[\s*['"`]delete['"`]\s*\])\s*(?:<[^()]*?>)?\s*\(\s*[`'"][^`'"]*\/contacts\/\$\{/;
  const CONCAT_CONTACT_PATH = /[`'"][^`'"\r\n]*\/contacts\/[`'"]\s*\+/;
  const SDK_CONTACT_REMOVE = /\bcontacts\s*\??\.\s*remove\s*\(|\bcontacts\s*(?:\?\.\s*)?\[\s*['"`]remove/;
  /** The files that can reach the Resend API: they import the SDK, its client or its base URL. */
  const REACHES_RESEND =
    /\bfrom\s+['"](?:resend|[^'"]*\/resend-broadcasts-client|[^'"]*\/resend-api-base-url)['"]|\brequire\(\s*['"]resend['"]\s*\)/;
  const forbiddenRaw = (source: string): string[] =>
    [RAW_CONTACT_PATH, CONCAT_CONTACT_PATH].filter((p) => p.test(source)).map(String);
  const forbidden = (source: string): string[] =>
    [...forbiddenRaw(source), ...(SDK_CONTACT_REMOVE.test(source) ? [String(SDK_CONTACT_REMOVE)] : [])];

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (/\.(?:ts|tsx|mts|cts|js|mjs)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('no file under src/ holds the SDK contacts.remove, and no Resend-reaching file a raw contact delete', () => {
    const all = sourceFiles(join(process.cwd(), 'src')).map((path) => ({ path, source: readFileSync(path, 'utf-8') }));
    const reaching = all.filter((f) => REACHES_RESEND.test(f.source));
    // Positive controls: the whole tree was read, the Resend-reaching set holds
    // the gateway and the broadcasts client, and the detach in the gateway is the
    // SDK's segment call, exactly once.
    expect(all.length).toBeGreaterThan(100);
    const gateway = reaching.find((f) => f.path.endsWith(GATEWAY));
    expect(gateway, 'the gateway reaches Resend and is scanned').toBeDefined();
    expect(reaching.some((f) => f.path.endsWith(join('resend', 'resend-broadcasts-client.ts')))).toBe(true);
    expect(gateway!.source.length).toBeGreaterThan(1000);
    expect(gateway!.source.split('contacts.segments.remove(')).toHaveLength(2);

    const sdkOffenders = all.filter((f) => SDK_CONTACT_REMOVE.test(f.source)).map((f) => f.path);
    expect(sdkOffenders).toEqual([]);
    const rawOffenders = reaching
      .map((f) => ({ path: f.path, hits: forbiddenRaw(f.source) }))
      .filter((f) => f.hits.length > 0);
    expect(rawOffenders).toEqual([]);
  });

  // The scan's own positive control: each forbidden shape it can see is caught,
  // CRLF included.
  it.each([
    ['the SDK account-wide delete', 'await sdk.contacts.remove({ email });'],
    ['a space before the paren', 'await sdk.contacts.remove ({ email });'],
    ['optional chaining', 'await sdk.contacts?.remove({ email });'],
    ['a bracket lookup', "await sdk.contacts['remove']({ email });"],
    ['a bracket lookup with spaces and double quotes', 'await sdk.contacts [ "remove" ]({ email });'],
    ['a member access across a CRLF', 'await sdk.contacts\r\n  .remove({ email });'],
    ['a raw fetch DELETE, CRLF', "await fetch(`${BASE}/contacts/${email}`, {\r\n  method: 'DELETE',\r\n});"],
    ['a raw fetch whose method is a const', 'const m = "DELETE" as const;\nawait fetch(`${BASE}/contacts/${email}`, { method: m });'],
    ['an importFetch, any method', 'await importFetch(\n  `/contacts/${encodeURIComponent(email)}`,\n  { method: "GET" },\n);'],
    ['the SDK low-level delete', 'await sdk.delete(`/contacts/${email}`);'],
    ['a concatenated path', 'await fetch(BASE + "/contacts/" + email, { method: "DELETE" });'],
    // PR #756 review round 3 (code-review #7, security L1).
    ['the SDK low-level delete with a type argument', 'await sdk.delete<{ deleted: boolean }>(`/contacts/${e}`);'],
    ['the SDK low-level delete by bracket', "await sdk['delete'](`/contacts/${e}`);"],
    ['optional chaining into a bracket lookup', "await sdk.contacts?.['remove']({ email });"],
  ])('the scan catches %s', (_label, snippet) => {
    expect(forbidden(snippet)).not.toEqual([]);
  });

  it('the scan passes the segment detach, the contact imports and a segment delete', () => {
    expect(forbidden('await sdk.contacts.segments.remove({ email, segmentId });')).toEqual([]);
    expect(forbidden("await importFetch('/contacts/imports', { method: 'POST' });")).toEqual([]);
    expect(forbidden('await importFetch(\n  `/contacts/imports/${encodeURIComponent(importId)}`,\n  { method: "GET" },\n);')).toEqual([]);
    expect(forbidden('await sdk.segments.remove(audienceId, { signal });')).toEqual([]);
  });

  // Recorded as out of reach (the docblock): pinned so a reader sees exactly
  // which forms the runtime guard alone covers.
  it.each([
    ['a destructured method', 'const { remove } = sdk.contacts;\nawait remove({ email });'],
    ['a path held in a variable', 'const p = `${BASE}/contacts/${email}`;\nawait fetch(p, { method: "DELETE" });'],
    ['a joined path', "await fetch([BASE, 'contacts', email].join('/'), { method: 'DELETE' });"],
    ['an aliased contacts object', 'const c = sdk.contacts; await c.remove({ email });'],
    ['a URL object', 'await fetch(new URL(`/contacts/${e}`, BASE), { method: "DELETE" });'],
  ])('out of reach of the source scan (runtime guard only): %s', (_label, snippet) => {
    expect(forbidden(snippet)).toEqual([]);
  });

  // Round 5 — two escapes of the IMPORTER filter rather than of the patterns: a
  // file that loads the SDK this way is not in the raw-path set, so a raw
  // contact delete in it is never scanned.
  it.each([
    ['a dynamic import', "const { Resend } = await import('resend');"],
    ['a barrel re-export', "import { resendBroadcastsClient } from '@/modules/broadcasts/infrastructure';"],
  ])('out of reach of the importer filter: %s', (_label, snippet) => {
    expect(REACHES_RESEND.test(snippet)).toBe(false);
  });
});

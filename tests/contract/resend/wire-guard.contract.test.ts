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

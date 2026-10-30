// @vitest-environment node
/**
 * Spec 141 RS1 — every SDK-backed call the Broadcasts gateway makes, on the
 * wire, through the REAL `resend` SDK against a stubbed `fetch`: method, URL,
 * Idempotency-Key and JSON body, and how the reply is read. The raw-fetch
 * calls (`*Once`, contact imports, the global contact delete) bypass the SDK
 * and keep their own tests. Written on resend 4.8 (green by design); a bump
 * that changes any of these requests or readings turns it red.
 *
 * The broadcast HTML is the chamber-branded wrapper (pinned by its own
 * baseline tests), so it is recorded here by length and a short hash only.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// resend@6.35 reads RESEND_BASE_URL / RESEND_USER_AGENT from the process env
// when a client is built; clear them first so every recorded URL and header
// is the SDK default on every machine (spec 141 review round 5).
vi.hoisted(() => {
  delete process.env['RESEND_BASE_URL'];
  delete process.env['RESEND_USER_AGENT'];
});
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import type { CreateBroadcastInput } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { logger } from '@/lib/logger';
import { json, stubWire, type WireCall } from './_wire';

const compact = (calls: readonly WireCall[]) =>
  calls.map((c) => {
    const body = c.body as Record<string, unknown> | null;
    if (body && typeof body === 'object' && typeof body['html'] === 'string') {
      const html = body['html'] as string;
      return { ...c, body: { ...body, html: `<${html.length} chars ${createHash('sha256').update(html).digest('hex').slice(0, 12)}>` } };
    }
    return c;
  });

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Broadcasts gateway SDK calls on the wire (spec 141)', () => {
  it('createAudience', async () => {
    const calls = stubWire(() => json(201, { object: 'audience', id: 'aud_1', name: 'probe' }));
    await expect(resendBroadcastsGateway.createAudience('probe')).resolves.toEqual({ audienceId: 'aud_1' });
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": {
            "name": "probe",
          },
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "POST",
          "url": "https://api.resend.com/segments",
        },
      ]
    `);
  });

  it('addContactsToAudience (one contact per call)', async () => {
    const calls = stubWire(() => json(201, { object: 'contact', id: 'c_1' }));
    await resendBroadcastsGateway.addContactsToAudience('aud_1', [
      { emailLower: 'a@example.com', firstName: 'Ann', lastName: 'Lee' },
      { emailLower: 'b@example.com' },
    ]);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": {
            "email": "a@example.com",
            "first_name": "Ann",
            "last_name": "Lee",
            "unsubscribed": false,
          },
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "POST",
          "url": "https://api.resend.com/audiences/aud_1/contacts",
        },
        {
          "bearer": true,
          "body": {
            "email": "b@example.com",
            "unsubscribed": false,
          },
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "POST",
          "url": "https://api.resend.com/audiences/aud_1/contacts",
        },
      ]
    `);
  });

  it('createBroadcast', async () => {
    const calls = stubWire(() => json(201, { id: 'bc_1' }));
    await expect(
      resendBroadcastsGateway.createBroadcast({
        audienceId: 'aud_1',
        subject: 'Hello',
        htmlBody: '<p>hi</p>',
        fromName: 'SweCham',
        fromEmail: 'noreply@example.com',
        replyToEmail: 'office@example.com',
        broadcastNameForResendDashboard: 'SweCham — Hello',
        tenantDisplayName: 'SweCham',
        locale: 'en',
      } satisfies CreateBroadcastInput),
    ).resolves.toEqual({ broadcastId: 'bc_1' });
    expect(compact(calls)).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": {
            "audience_id": "aud_1",
            "from": "SweCham <noreply@example.com>",
            "html": "<2019 chars 2af02727f09c>",
            "name": "SweCham — Hello",
            "reply_to": "office@example.com",
            "subject": "Hello",
          },
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "POST",
          "url": "https://api.resend.com/broadcasts",
        },
      ]
    `);
  });

  it('sendBroadcast carries the Idempotency-Key header', async () => {
    const calls = stubWire(() => json(200, { id: 'bc_1' }));
    await resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1');
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": {},
          "contentType": "application/json",
          "idempotencyKey": "idem-key-1",
          "method": "POST",
          "url": "https://api.resend.com/broadcasts/bc_1/send",
        },
      ]
    `);
  });

  it('retrieveBroadcast reads status and sent_at', async () => {
    const calls = stubWire(() => json(200, { object: 'broadcast', id: 'bc_1', status: 'sent', sent_at: '2026-10-30T00:00:00Z' }));
    await expect(resendBroadcastsGateway.retrieveBroadcast('bc_1')).resolves.toMatchInlineSnapshot(`
      {
        "kind": "present",
        "resource": {
          "id": "bc_1",
          "sentAt": "2026-10-30T00:00:00Z",
          "status": "sent",
        },
      }
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "GET",
          "url": "https://api.resend.com/broadcasts/bc_1",
        },
      ]
    `);
  });

  it('retrieveBroadcast reads a 404 as not_found', async () => {
    stubWire(() => json(404, { statusCode: 404, name: 'not_found', message: 'Broadcast not found' }));
    await expect(resendBroadcastsGateway.retrieveBroadcast('bc_gone')).resolves.toMatchInlineSnapshot(`
      {
        "kind": "not_found",
      }
    `);
  });

  it('getAudienceContactCount reads data length and has_more', async () => {
    const calls = stubWire(() => json(200, { object: 'list', has_more: false, data: [{ id: 'c_1' }, { id: 'c_2' }] }));
    await expect(resendBroadcastsGateway.getAudienceContactCount('aud_1')).resolves.toMatchInlineSnapshot(`
      {
        "complete": true,
        "count": 2,
      }
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "GET",
          "url": "https://api.resend.com/segments/aud_1/contacts",
        },
      ]
    `);
  });

  it('removeContactFromAudience', async () => {
    const calls = stubWire(() => json(200, { object: 'contact', deleted: true }));
    await expect(resendBroadcastsGateway.removeContactFromAudience('aud_1', 'a@example.com')).resolves.toMatchInlineSnapshot(`
      {
        "kind": "detached",
      }
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "DELETE",
          "url": "https://api.resend.com/audiences/aud_1/contacts/a@example.com",
        },
      ]
    `);
  });

  it('listAudiences', async () => {
    const calls = stubWire(() =>
      json(200, { object: 'list', data: [{ id: 'aud_1', name: 'probe', created_at: '2026-10-30T00:00:00Z' }] }),
    );
    await expect(resendBroadcastsGateway.listAudiences()).resolves.toMatchInlineSnapshot(`
      [
        {
          "createdAt": 2026-10-30T00:00:00.000Z,
          "id": "aud_1",
          "name": "probe",
        },
      ]
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "GET",
          "url": "https://api.resend.com/segments?limit=100",
        },
      ]
    `);
  });

  // Review round 3: on 6.35 `audiences.list` is the paginated `GET /segments`,
  // so the gateway follows `has_more` instead of reading page 1 only.
  it('listAudiences follows has_more across pages', async () => {
    const calls = stubWire((n) =>
      n === 1
        ? json(200, { object: 'list', has_more: true, data: [{ id: 'aud_1', name: 'a', created_at: '2026-10-30T00:00:00Z' }] })
        : json(200, { object: 'list', has_more: false, data: [{ id: 'aud_2', name: 'b', created_at: '2026-10-30T00:00:00Z' }] }),
    );
    const rows = await resendBroadcastsGateway.listAudiences();
    expect({ ids: rows.map((r) => r.id), urls: calls.map((c) => c.url) }).toEqual({
      ids: ['aud_1', 'aud_2'],
      urls: ['https://api.resend.com/segments?limit=100', 'https://api.resend.com/segments?limit=100&after=aud_1'],
    });
  });

  it('listAudiences stops on a repeated cursor and returns each audience once', async () => {
    const calls = stubWire(() =>
      json(200, { object: 'list', has_more: true, data: [{ id: 'aud_1', name: 'a', created_at: '2026-10-30T00:00:00Z' }] }),
    );
    const rows = await resendBroadcastsGateway.listAudiences();
    expect({ ids: rows.map((r) => r.id), pages: calls.length }).toEqual({ ids: ['aud_1'], pages: 2 });
  });

  it('listAudiences: an empty page that still says has_more is logged as truncated', async () => {
    const warn = vi.spyOn(logger, 'warn');
    stubWire((n) =>
      n === 1
        ? json(200, { object: 'list', has_more: true, data: [{ id: 'aud_1', name: 'a', created_at: '2026-10-30T00:00:00Z' }] })
        : json(200, { object: 'list', has_more: true, data: [] }),
    );
    await resendBroadcastsGateway.listAudiences();
    expect(warn.mock.calls.map((c) => c[1])).toContain('resend.broadcasts.audiences_list_truncated');
    warn.mockRestore();
  });

  it('addContactsToAudience with no contacts is a no-op, even for a blank id (no request)', async () => {
    const calls = stubWire(() => json(201, { object: 'contact', id: 'c_1' }));
    await expect(resendBroadcastsGateway.addContactsToAudience('', [])).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('deleteAudience, and a 404 counts as already gone', async () => {
    const calls = stubWire((n) =>
      n === 1 ? json(200, { object: 'audience', id: 'aud_1', deleted: true }) : json(404, { statusCode: 404, name: 'not_found', message: 'Audience not found' }),
    );
    await resendBroadcastsGateway.deleteAudience('aud_1');
    await resendBroadcastsGateway.deleteAudience('aud_gone');
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "DELETE",
          "url": "https://api.resend.com/segments/aud_1",
        },
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "DELETE",
          "url": "https://api.resend.com/segments/aud_gone",
        },
      ]
    `);
  });

  it('deleteBroadcast, and a 404 counts as already gone', async () => {
    const calls = stubWire((n) =>
      n === 1 ? json(200, { object: 'broadcast', id: 'bc_1', deleted: true }) : json(404, { statusCode: 404, name: 'not_found', message: 'Broadcast not found' }),
    );
    await resendBroadcastsGateway.deleteBroadcast('bc_1');
    await resendBroadcastsGateway.deleteBroadcast('bc_gone');
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "DELETE",
          "url": "https://api.resend.com/broadcasts/bc_1",
        },
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "DELETE",
          "url": "https://api.resend.com/broadcasts/bc_gone",
        },
      ]
    `);
  });

  // architect pre-read: 6.35 attaches `statusCode` to a non-JSON error body,
  // where 4.8 left it undefined (read as 500, so retried). The gateway keeps
  // the 4.8 reading (option A, 30 Oct 2026); see the block at the end.
  it('a 413 with a non-JSON body: how many attempts', async () => {
    vi.useFakeTimers();
    const calls = stubWire(() => new Response('<html>Request Entity Too Large</html>', { status: 413, headers: { 'content-type': 'text/html' } }));
    const done = resendBroadcastsGateway.createAudience('probe').then(
      () => 'resolved',
      (e: { kind?: string }) => e.kind ?? 'threw',
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ outcome: await done, attempts: calls.length }).toMatchInlineSnapshot(`
      {
        "attempts": 6,
        "outcome": "retryable",
      }
    `);
  });

  it('a 422 on create is permanent (no retry)', async () => {
    const calls = stubWire(() => json(422, { statusCode: 422, name: 'validation_error', message: 'Invalid `from` field.' }));
    await expect(resendBroadcastsGateway.createAudience('probe')).rejects.toMatchObject({ kind: 'permanent' });
    expect(calls).toHaveLength(1);
  });

  // Review round 1 (spec 141): on 6.35 a falsy `audienceId` makes the SDK
  // drop the audience from the path — `contacts.remove` becomes
  // `DELETE /contacts/{email}`, an ACCOUNT-WIDE delete shared by every tenant,
  // and `contacts.list` becomes `GET /contacts`. The gateway refuses an empty id
  // (or an empty email) before any request.
  describe('an empty id never reaches the SDK', () => {
    it.each([
      ['removeContactFromAudience, empty audience', () => resendBroadcastsGateway.removeContactFromAudience('', 'a@example.com')],
      ['removeContactFromAudience, empty email', () => resendBroadcastsGateway.removeContactFromAudience('aud_1', '')],
      ['addContactsToAudience', () => resendBroadcastsGateway.addContactsToAudience('', [{ emailLower: 'a@example.com' }])],
      ['getAudienceContactCount', () => resendBroadcastsGateway.getAudienceContactCount('')],
      ['deleteAudience', () => resendBroadcastsGateway.deleteAudience('')],
      ['createBroadcast', () =>
        resendBroadcastsGateway.createBroadcast({
          audienceId: '',
          subject: 'Hello',
          htmlBody: '<p>hi</p>',
          fromName: 'SweCham',
          fromEmail: 'noreply@example.com',
          replyToEmail: 'office@example.com',
          broadcastNameForResendDashboard: 'SweCham — Hello',
          tenantDisplayName: 'SweCham',
          locale: 'en',
        })],
      ['sendBroadcast', () => resendBroadcastsGateway.sendBroadcast('', 'idem-key-1')],
      ['retrieveBroadcast', () => resendBroadcastsGateway.retrieveBroadcast('')],
      ['deleteBroadcast', () => resendBroadcastsGateway.deleteBroadcast('')],
      ['deleteContactGlobally', () => resendBroadcastsGateway.deleteContactGlobally('')],
      ['createContactImport', () => resendBroadcastsGateway.createContactImport('', ['a@example.com'])],
      ['getContactImport', () => resendBroadcastsGateway.getContactImport('')],
      ['a null email from a nullable column', () =>
        resendBroadcastsGateway.removeContactFromAudience('aud_1', null as unknown as string)],
    ])('%s', async (_name, run) => {
      const calls = stubWire(() => json(200, { object: 'list', has_more: false, data: [] }));
      await expect(run()).rejects.toMatchObject({ kind: 'permanent', code: 'empty_identifier' });
      expect(calls).toHaveLength(0);
    });

    it.each([
      ['retrieveBroadcastOnce', () => resendBroadcastsGateway.retrieveBroadcastOnce('')],
      ['deleteBroadcastOnce', () => resendBroadcastsGateway.deleteBroadcastOnce('')],
    ])('%s answers other, with no request', async (_name, run) => {
      const calls = stubWire(() => json(200, { object: 'list', data: [] }));
      await expect(run()).resolves.toEqual({ kind: 'other' });
      expect(calls).toHaveLength(0);
    });
  });

  it('a network failure that never clears is retryable, tagged network', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const done = resendBroadcastsGateway.createAudience('probe').then(
      () => null,
      (e: { kind?: string; subKind?: string }) => ({ kind: e.kind, subKind: e.subKind }),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await done).toEqual({ kind: 'retryable', subKind: 'network' });
  });

  it('a network failure is retryable (network)', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 1) throw new TypeError('fetch failed');
        return json(201, { object: 'audience', id: 'aud_net', name: 'probe' });
      }),
    );
    const done = resendBroadcastsGateway.createAudience('probe');
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ value: await done, attempts: n }).toMatchInlineSnapshot(`
      {
        "attempts": 2,
        "value": {
          "audienceId": "aud_net",
        },
      }
    `);
  });

  // The maintainer's choice (30 Oct 2026, option A): a non-JSON error body
  // (an edge's or proxy's HTML page) is read as 4.8 read it, a transient 500
  // retried six times, whatever status it carries. 6.35 started passing that
  // status through, so an HTML 404 read as "already gone" — on the erasure path
  // a false "already absent" in the Art. 30 record. Only a real Resend error
  // (JSON, a specific `name`) keeps its status.
  describe('a non-JSON error body is a transient 500, as on 4.8', () => {
    const html = (status: number) => () =>
      new Response(`<html>${status}</html>`, { status, headers: { 'content-type': 'text/html' } });
    it.each([
      ['retrieveBroadcast, HTML 404', 404, () => resendBroadcastsGateway.retrieveBroadcast('bc_1')],
      ['deleteAudience, HTML 404', 404, () => resendBroadcastsGateway.deleteAudience('aud_1')],
      ['deleteBroadcast, HTML 410', 410, () => resendBroadcastsGateway.deleteBroadcast('bc_1')],
      ['removeContactFromAudience, HTML 404 (the erasure path)', 404, () =>
        resendBroadcastsGateway.removeContactFromAudience('aud_1', 'a@example.com')],
      ['addContactsToAudience, HTML 404', 404, () =>
        resendBroadcastsGateway.addContactsToAudience('aud_1', [{ emailLower: 'a@example.com' }])],
      ['sendBroadcast, HTML 409', 409, () => resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1')],
      ['createAudience, HTML 413', 413, () => resendBroadcastsGateway.createAudience('probe')],
      ['createAudience, HTML 429', 429, () => resendBroadcastsGateway.createAudience('probe')],
    ])('%s', async (_name, status, run) => {
      vi.useFakeTimers();
      const calls = stubWire(html(status));
      const done = (run() as Promise<unknown>).then(
        () => ({ outcome: 'resolved' }),
        (e: { kind?: string; subKind?: string }) => ({ outcome: e.kind ?? 'threw', subKind: e.subKind ?? null }),
      );
      await vi.advanceTimersByTimeAsync(40_000);
      expect({ ...(await done), attempts: calls.length }).toEqual({
        outcome: 'retryable',
        subKind: 'server_5xx',
        attempts: 6,
      });
    });

    // Review round 3 (the maintainer: "fix it"): the raw-fetch calls follow
    // the same rule — "gone" needs Resend's own JSON error, never an HTML page.
    it.each([
      ['deleteBroadcastOnce', () => resendBroadcastsGateway.deleteBroadcastOnce('bc_1')],
      ['retrieveBroadcastOnce', () => resendBroadcastsGateway.retrieveBroadcastOnce('bc_1')],
    ])('%s, HTML 404 is retryable, not gone', async (_name, run) => {
      stubWire(html(404));
      await expect(run()).resolves.toEqual({ kind: 'retryable' });
    });
    it.each([
      ['deleteBroadcastOnce', () => resendBroadcastsGateway.deleteBroadcastOnce('bc_1'), { kind: 'absent' }],
      ['retrieveBroadcastOnce', () => resendBroadcastsGateway.retrieveBroadcastOnce('bc_1'), { kind: 'not_found' }],
    ])('%s, a real JSON 404 is still gone', async (_name, run, expected) => {
      stubWire(() => json(404, { statusCode: 404, name: 'not_found', message: 'Broadcast not found' }));
      await expect(run()).resolves.toEqual(expected);
    });
    it('deleteContactGlobally, HTML 404 is retried, not gone', async () => {
      vi.useFakeTimers();
      const calls = stubWire(html(404));
      const done = resendBroadcastsGateway.deleteContactGlobally('a@example.com').then(
        () => ({ outcome: 'resolved' }),
        (e: { kind?: string }) => ({ outcome: e.kind ?? 'threw' }),
      );
      await vi.advanceTimersByTimeAsync(40_000);
      expect({ ...(await done), attempts: calls.length }).toEqual({ outcome: 'retryable', attempts: 6 });
    });
    it('createContactImport, a raw non-JSON 413 stays permanent (only 404 / 410 need Resend\'s JSON)', async () => {
      const calls = stubWire(html(413));
      await expect(resendBroadcastsGateway.createContactImport('aud_1', ['a@example.com'])).rejects.toMatchObject({
        kind: 'permanent',
      });
      expect(calls).toHaveLength(1);
    });

    it('deleteContactGlobally, a real JSON 404 is still gone', async () => {
      stubWire(() => json(404, { statusCode: 404, name: 'not_found', message: 'Contact not found' }));
      await expect(resendBroadcastsGateway.deleteContactGlobally('a@example.com')).resolves.toBeUndefined();
    });

    it('removeContactFromAudience, a real JSON 404 is still already absent', async () => {
      stubWire(() => json(404, { statusCode: 404, name: 'not_found', message: 'Contact not found' }));
      await expect(resendBroadcastsGateway.removeContactFromAudience('aud_1', 'a@example.com')).resolves.toEqual({
        kind: 'already_absent',
      });
    });
  });
});

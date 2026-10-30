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
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import type { CreateBroadcastInput } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
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
          "url": "https://api.resend.com/segments",
        },
      ]
    `);
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
  // where 4.8 left it undefined (read as 500, so retried). Pinned here so the
  // bump shows the change rather than hiding it.
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
        "attempts": 1,
        "outcome": "permanent",
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
    ])('%s', async (_name, run) => {
      const calls = stubWire(() => json(200, { object: 'list', has_more: false, data: [] }));
      await expect(run()).rejects.toMatchObject({ kind: 'permanent', code: 'empty_identifier' });
      expect(calls).toHaveLength(0);
    });
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

  // Accepted by the maintainer (30 Oct 2026): on 6.35 a non-JSON error body
  // carries its real HTTP status, so an HTML 404 from an edge reads as
  // "missing" / "already gone", where 4.8 read every such body as a 500 and
  // retried. Pinned so the next bump shows any change.
  describe('a non-JSON error body keeps its HTTP status (6.35)', () => {
    const settle = (p: Promise<unknown>) =>
      p.then(
        (v) => ({ resolved: v ?? null }),
        (e: { kind?: string; code?: string }) => ({ rejected: e.kind ?? 'threw', code: e.code ?? null }),
      );
    it('retrieveBroadcast, HTML 404', async () => {
      stubWire(() => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
      expect(await settle(resendBroadcastsGateway.retrieveBroadcast('bc_1'))).toMatchInlineSnapshot(`
        {
          "resolved": {
            "kind": "not_found",
          },
        }
      `);
    });
    it('deleteAudience, HTML 404', async () => {
      stubWire(() => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
      expect(await settle(resendBroadcastsGateway.deleteAudience('aud_1'))).toMatchInlineSnapshot(`
        {
          "resolved": null,
        }
      `);
    });
    it('sendBroadcast, HTML 409', async () => {
      stubWire(() => new Response('<html>409</html>', { status: 409, headers: { 'content-type': 'text/html' } }));
      expect(await settle(resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1'))).toMatchInlineSnapshot(`
        {
          "code": null,
          "rejected": "idempotency_conflict",
        }
      `);
    });
    it('createAudience, HTML 429', async () => {
      vi.useFakeTimers();
      const calls = stubWire(() => new Response('<html>429</html>', { status: 429, headers: { 'content-type': 'text/html' } }));
      const done = settle(resendBroadcastsGateway.createAudience('probe'));
      await vi.advanceTimersByTimeAsync(40_000);
      expect({ outcome: await done, attempts: calls.length }).toMatchInlineSnapshot(`
        {
          "attempts": 6,
          "outcome": {
            "code": null,
            "rejected": "retryable",
          },
        }
      `);
    });
  });
});

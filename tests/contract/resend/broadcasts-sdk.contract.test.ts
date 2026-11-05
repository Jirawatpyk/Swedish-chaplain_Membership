// @vitest-environment node
/**
 * Spec 141 RS1 — every SDK-backed call the Broadcasts gateway makes, on the
 * wire, through the REAL `resend` SDK against a stubbed `fetch`: method, URL,
 * Idempotency-Key and JSON body, and how the reply is read. The raw-fetch
 * calls (`*Once`, contact imports) bypass the SDK and keep their own tests.
 * Written on resend 4.8 (green by design); a bump that changes any of these
 * requests or readings turns it red. Spec 140 s4 moved the calls to the
 * Segments names (`segments.*`, `segmentId`, `contacts.segments.remove`); the
 * URLs below are the ones step 0 measured (research.md, slice 4 addendum).
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
import {
  RESEND_CALL_TIMEOUT_MS,
  type CreateBroadcastInput,
} from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { logger } from '@/lib/logger';
import { json, stubWire, type WireCall } from './_wire';

// Spec 140 DT4 — `removeContactFromAudience` refuses an audience id that is not
// UUID-shaped, so its cases use a real-shaped id (every segment id Resend has
// returned is one, research.md slice 3 step 0).
const AUD = '0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19';
/** A second segment id, for the cases that read an already-deleted segment. */
const AUD_GONE = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';

/** Spec 140 DT5 — a `listAudiences` deadline no page in these cases comes near. */
const farDeadline = () => new Date(Date.now() + 10 * 60_000);

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

  // Spec 140 s3 review round 1 (R1-A) — Resend matches a segment contact by its
  // exact case (MEASURED 5 Nov 2026), and the erasure detach sends the address
  // lowercase. So the import sends `toLowerCase()` of each address: the one the
  // detach will send. (The per-contact push, the other path, went with the legacy
  // leg in spec 140 s4.)
  it('createContactImport puts each address in the CSV lowercased', async () => {
    const csvs: string[] = [];
    stubWire(async (_n, _input, init) => {
      const file = (init?.body as FormData).get('file') as Blob;
      csvs.push(await file.text());
      return json(200, { object: 'contact_import', id: 'imp_1' });
    });
    await expect(
      resendBroadcastsGateway.createContactImport(AUD, ['a@example.com', 'Mixed.Case@Example.com']),
    ).resolves.toEqual({ importId: 'imp_1' });
    expect(csvs).toEqual(['email\na@example.com\nmixed.case@example.com\n']);
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
            "from": "SweCham <noreply@example.com>",
            "html": "<2019 chars 2af02727f09c>",
            "name": "SweCham — Hello",
            "reply_to": "office@example.com",
            "segment_id": "aud_1",
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
    await expect(resendBroadcastsGateway.getAudienceContactCount(AUD)).resolves.toMatchInlineSnapshot(`
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
          "url": "https://api.resend.com/segments/0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19/contacts",
        },
      ]
    `);
  });

  // Spec 140 s4 — the detach is `contacts.segments.remove`, the segment-scoped
  // `DELETE /contacts/{email}/segments/{id}` (research.md slice 4 step 0 item 1,
  // MEASURED 5 Nov 2026: `200 {"object":"contact_segment","deleted":true}`).
  it('removeContactFromAudience', async () => {
    const calls = stubWire(() => json(200, { object: 'contact_segment', deleted: true }));
    await expect(resendBroadcastsGateway.removeContactFromAudience(AUD, 'a@example.com')).resolves.toMatchInlineSnapshot(`
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
          "url": "https://api.resend.com/contacts/a@example.com/segments/0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19",
        },
      ]
    `);
  });

  // Spec 140 s4 (research.md slice 4 step 0 item 1, MEASURED 5 Nov 2026): the SDK
  // puts the email in the path unencoded and as given; Resend reads the `+`
  // literally and matches the address case-SENSITIVELY, and the contact itself
  // survives the detach. So the gateway neither encodes nor re-cases it: the
  // address it is given is lowercase because the erasure capture is lowercase
  // and the import lowercases. An SDK bump that starts encoding turns this red.
  it.each([
    ['a + address', 'delivered+x@resend.dev'],
    ['an uppercase address', 'DELIVERED.UP@resend.dev'],
  ])('removeContactFromAudience sends %s literally and reads 200 deleted:true as detached', async (_label, email) => {
    const calls = stubWire(() => json(200, { object: 'contact_segment', deleted: true }));
    await expect(resendBroadcastsGateway.removeContactFromAudience(AUD, email)).resolves.toEqual({ kind: 'detached' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE https://api.resend.com/contacts/${email}/segments/${AUD}`,
    ]);
  });

  it('removeContactFromAudience accepts an uppercase-hex UUID (matched case-insensitively)', async () => {
    const calls = stubWire(() => json(200, { object: 'contact_segment', deleted: true }));
    await expect(resendBroadcastsGateway.removeContactFromAudience(AUD.toUpperCase(), 'a@example.com')).resolves.toEqual({
      kind: 'detached',
    });
    expect(calls).toHaveLength(1);
  });

  // Spec 140 s4 (research.md slice 4 step 0 items 1 and 4, MEASURED 5 Nov 2026):
  // on this endpoint every no-op answered `404 not_found`, and only a membership
  // that existed answered `200 deleted:true`. So a 404 is `already_absent`, which
  // the erasure record counts apart from a detach. The bodies are the measured ones.
  it.each([
    ['a random segment', 'Audience not found'],
    ['the wrong case of a stored address', 'Contact not found'],
    ['a contact in no segment (a non-member)', "Audience not found in contact's audience list"],
  ])('removeContactFromAudience reads a 404 for %s as already_absent, one request', async (_label, message) => {
    const calls = stubWire(() => json(404, { statusCode: 404, name: 'not_found', message }));
    await expect(resendBroadcastsGateway.removeContactFromAudience(AUD, 'a@example.com')).resolves.toEqual({
      kind: 'already_absent',
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE https://api.resend.com/contacts/a@example.com/segments/${AUD}`,
    ]);
  });

  // PR #756 review round 1 (code-review #4) — a 410 Gone is "already gone" as a
  // 404 is, on this call as on its siblings `deleteAudience` / `deleteBroadcast`
  // (`isProviderGone`). Read as `permanent`, the erasure record would count a
  // member's detach FAILED and send an operator to remediate a no-op.
  it('removeContactFromAudience reads a JSON 410 Gone as already_absent, one request', async () => {
    const calls = stubWire(() => json(410, { statusCode: 410, name: 'gone', message: 'Segment gone' }));
    await expect(resendBroadcastsGateway.removeContactFromAudience(AUD, 'a@example.com')).resolves.toEqual({
      kind: 'already_absent',
    });
    expect(calls).toHaveLength(1);
  });

  // Spec 140 s4 — `detached` reaches an append-only Art. 30 record as a removal,
  // so it needs Resend's own `deleted: true`. Never measured, so read
  // conservatively: a 200 without it is not a detach. It is a permanent failure
  // the erasure record counts as failed (remediated by hand), never a removal.
  it.each([
    ['deleted: false', { object: 'contact_segment', deleted: false }],
    ['no deleted field', { object: 'contact_segment' }],
  ])('removeContactFromAudience: a 200 with %s is not a detach (permanent, one request)', async (_label, body) => {
    const calls = stubWire(() => json(200, body));
    await expect(resendBroadcastsGateway.removeContactFromAudience(AUD, 'a@example.com')).rejects.toMatchObject({
      name: 'GatewayThrowable',
      kind: 'permanent',
      code: 'detach_unconfirmed',
    });
    expect(calls).toHaveLength(1);
  });

  // Spec 140 s4 plan review — the detach passes Resend's status and name only
  // into the classification, never its message: the thrown reason reaches log
  // lines, and a later wording change could put the address into it.
  it('removeContactFromAudience: a Resend error message carrying the address never reaches the thrown reason', async () => {
    stubWire(() => json(422, { statusCode: 422, name: 'validation_error', message: 'Invalid contact a@example.com' }));
    const thrown = await resendBroadcastsGateway.removeContactFromAudience(AUD, 'a@example.com').then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toMatchObject({ name: 'GatewayThrowable', kind: 'permanent', code: 'validation_error' });
    expect((thrown as Error).message).not.toContain('a@example.com');
    expect(JSON.stringify(thrown)).not.toContain('a@example.com');
  });

  it('listAudiences', async () => {
    const calls = stubWire(() =>
      json(200, { object: 'list', data: [{ id: 'aud_1', name: 'probe', created_at: '2026-10-30T00:00:00Z' }] }),
    );
    await expect(resendBroadcastsGateway.listAudiences({ deadlineAt: farDeadline() })).resolves.toMatchInlineSnapshot(`
      {
        "audiences": [
          {
            "createdAt": 2026-10-30T00:00:00.000Z,
            "id": "aud_1",
            "name": "probe",
          },
        ],
        "truncated": false,
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
    const { audiences: rows, truncated } = await resendBroadcastsGateway.listAudiences({ deadlineAt: farDeadline() });
    expect({ ids: rows.map((r) => r.id), urls: calls.map((c) => c.url), truncated }).toEqual({
      truncated: false,
      ids: ['aud_1', 'aud_2'],
      urls: ['https://api.resend.com/segments?limit=100', 'https://api.resend.com/segments?limit=100&after=aud_1'],
    });
  });

  it('listAudiences stops on a repeated cursor and returns each audience once', async () => {
    const calls = stubWire(() =>
      json(200, { object: 'list', has_more: true, data: [{ id: 'aud_1', name: 'a', created_at: '2026-10-30T00:00:00Z' }] }),
    );
    const { audiences: rows, truncated } = await resendBroadcastsGateway.listAudiences({ deadlineAt: farDeadline() });
    expect({ ids: rows.map((r) => r.id), pages: calls.length, truncated }).toEqual({
      ids: ['aud_1'],
      pages: 2,
      truncated: true,
    });
  });

  it('listAudiences: an empty page that still says has_more is truncated, and logged', async () => {
    const warn = vi.spyOn(logger, 'warn');
    stubWire((n) =>
      n === 1
        ? json(200, { object: 'list', has_more: true, data: [{ id: 'aud_1', name: 'a', created_at: '2026-10-30T00:00:00Z' }] })
        : json(200, { object: 'list', has_more: true, data: [] }),
    );
    await expect(resendBroadcastsGateway.listAudiences({ deadlineAt: farDeadline() })).resolves.toMatchObject({
      truncated: true,
    });
    expect(warn.mock.calls.map((c) => c[1])).toContain('resend.broadcasts.audiences_list_truncated');
    warn.mockRestore();
  });

  // Spec 140 DT5 — a per-invocation budget: the gateway starts a page only
  // while one bounded call (`callTimeoutMs`, RESEND_CALL_TIMEOUT_MS = 10 s here)
  // still fits before the caller's deadline, and says the list is cut. The
  // budget is read from `Date.now()`, so the test moves that clock by hand
  // (`AbortSignal.timeout` runs on real timers, which fake timers cannot drive).
  describe("listAudiences stops at the caller's deadline (spec 140 DT5)", () => {
    const page = (id: string) =>
      json(200, { object: 'list', has_more: true, data: [{ id, name: id, created_at: '2026-10-30T00:00:00Z' }] });

    it('a deadline less than one call away sends no request and answers truncated', async () => {
      const calls = stubWire(() => page('aud_1'));
      await expect(
        resendBroadcastsGateway.listAudiences({ deadlineAt: new Date(Date.now() + RESEND_CALL_TIMEOUT_MS - 1) }),
      ).resolves.toEqual({ audiences: [], truncated: true });
      expect(calls).toHaveLength(0);
    });

    it('paging stops once less than one call is left, keeping the pages read', async () => {
      const realNow = Date.now.bind(Date);
      let elapsed = 0;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsed);
      try {
        const deadlineAt = new Date(Date.now() + 25_000);
        // Each page "takes" 8 s: page 1 starts with 25 s left, page 2 with 17 s,
        // and a third would start with 9 s, under one 10 s call.
        const calls = stubWire((n) => {
          elapsed += 8_000;
          return page(`aud_${n}`);
        });
        const result = await resendBroadcastsGateway.listAudiences({ deadlineAt });
        expect({ ids: result.audiences.map((a) => a.id), truncated: result.truncated, pages: calls.length }).toEqual({
          ids: ['aud_1', 'aud_2'],
          truncated: true,
          pages: 2,
        });
      } finally {
        now.mockRestore();
      }
    });
  });

  it('deleteAudience, and a 404 counts as already gone', async () => {
    const calls = stubWire((n) =>
      n === 1 ? json(200, { object: 'segment', id: AUD, deleted: true }) : json(404, { statusCode: 404, name: 'not_found', message: 'Audience not found' }),
    );
    await resendBroadcastsGateway.deleteAudience(AUD);
    await resendBroadcastsGateway.deleteAudience(AUD_GONE);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "DELETE",
          "url": "https://api.resend.com/segments/0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19",
        },
        {
          "bearer": true,
          "body": null,
          "contentType": "application/json",
          "idempotencyKey": null,
          "method": "DELETE",
          "url": "https://api.resend.com/segments/7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
        },
      ]
    `);
  });

  /**
   * Spec 140 s2c Verify finding — MEASURED 2026-11-03 on the sink account while
   * it held only the `General` segment: `GET /audiences/{id}` of a deleted
   * audience → 404, but `DELETE` of it → 403 `validation_error` "Cannot delete
   * last audience." (Resend checks "last audience" before it checks the id). So
   * a 403 is probed ONCE, inside the same call budget: 404 / 410 → already gone;
   * anything else → the DELETE's own classification is thrown.
   */
  describe("deleteAudience: a 403 is probed with one GET (the 'last audience' answer)", () => {
    const lastAudience = () =>
      json(403, { statusCode: 403, name: 'validation_error', message: 'Cannot delete last audience.' });

    it("a 403 'last audience' whose probe answers 404 is absent", async () => {
      const info = vi.spyOn(logger, 'info');
      const calls = stubWire((n) =>
        n === 1 ? lastAudience() : json(404, { statusCode: 404, name: 'not_found', message: 'Segment not found' }),
      );
      await expect(resendBroadcastsGateway.deleteAudience(AUD_GONE)).resolves.toBeUndefined();
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `DELETE https://api.resend.com/segments/${AUD_GONE}`,
        `GET https://api.resend.com/segments/${AUD_GONE}`,
      ]);
      expect(info).toHaveBeenCalledWith(
        { audienceId: AUD_GONE, via: 'probe_after_403' },
        'resend.broadcasts.audience_already_absent',
      );
      info.mockRestore();
    });

    it('a 403 whose probe finds the audience throws the DELETE classification (permanent), with no retry', async () => {
      const calls = stubWire((n) =>
        n === 1 ? lastAudience() : json(200, { object: 'segment', id: AUD, name: 'General' }),
      );
      await expect(resendBroadcastsGateway.deleteAudience(AUD)).rejects.toMatchObject({
        name: 'GatewayThrowable',
        kind: 'permanent',
        code: 'validation_error',
      });
      expect(calls).toHaveLength(2);
    });

    it('a 403 whose probe fails (5xx) throws the DELETE classification, with no retry', async () => {
      const calls = stubWire((n) =>
        n === 1 ? lastAudience() : json(503, { statusCode: 503, name: 'internal_server_error', message: 'down' }),
      );
      await expect(resendBroadcastsGateway.deleteAudience(AUD)).rejects.toMatchObject({
        name: 'GatewayThrowable',
        kind: 'permanent',
        code: 'validation_error',
      });
      expect(calls).toHaveLength(2);
    });

    it('a 403 whose probe throws (network) throws the DELETE classification', async () => {
      const calls = stubWire((n) => {
        if (n === 1) return lastAudience();
        throw new TypeError('fetch failed');
      });
      await expect(resendBroadcastsGateway.deleteAudience(AUD)).rejects.toMatchObject({
        name: 'GatewayThrowable',
        kind: 'permanent',
        code: 'validation_error',
      });
      expect(calls).toHaveLength(2);
    });

    it('a 404 on the DELETE itself still needs no probe (one request)', async () => {
      const calls = stubWire(() => json(404, { statusCode: 404, name: 'not_found', message: 'Segment not found' }));
      await expect(resendBroadcastsGateway.deleteAudience(AUD_GONE)).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    });
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
  // Spec 140 s2a: a create makes one attempt (DL5a).
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
        "outcome": "retryable",
      }
    `);
  });

  it('a 422 on create is permanent (no retry)', async () => {
    const calls = stubWire(() => json(422, { statusCode: 422, name: 'validation_error', message: 'Invalid `from` field.' }));
    await expect(resendBroadcastsGateway.createAudience('probe')).rejects.toMatchObject({ kind: 'permanent' });
    expect(calls).toHaveLength(1);
  });

  // Review round 1 (spec 141): on 6.35 a falsy segment id makes the SDK drop it
  // from the path — `contacts.list` becomes `GET /contacts`, the whole account,
  // and the old `contacts.remove` became `DELETE /contacts/{email}`, an
  // ACCOUNT-WIDE delete (spec 140 s4 moved the detach to
  // `contacts.segments.remove`). The gateway refuses an empty id (or an empty
  // email) before any request.
  describe('an empty id never reaches the SDK', () => {
    it.each([
      ['removeContactFromAudience, empty audience', () => resendBroadcastsGateway.removeContactFromAudience('', 'a@example.com')],
      ['removeContactFromAudience, whitespace audience', () => resendBroadcastsGateway.removeContactFromAudience('  ', 'a@example.com')],
      ['removeContactFromAudience, null audience', () =>
        resendBroadcastsGateway.removeContactFromAudience(null as unknown as string, 'a@example.com')],
      ['removeContactFromAudience, undefined audience', () =>
        resendBroadcastsGateway.removeContactFromAudience(undefined as unknown as string, 'a@example.com')],
      ['removeContactFromAudience, empty email', () => resendBroadcastsGateway.removeContactFromAudience(AUD, '')],
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
      ['createContactImport', () => resendBroadcastsGateway.createContactImport('', ['a@example.com'])],
      ['getContactImport', () => resendBroadcastsGateway.getContactImport('')],
      ['a null email from a nullable column', () =>
        resendBroadcastsGateway.removeContactFromAudience(AUD, null as unknown as string)],
    ])('%s', async (_name, run) => {
      const calls = stubWire(() => json(200, { object: 'list', has_more: false, data: [] }));
      await expect(run()).rejects.toMatchObject({ kind: 'permanent', code: 'empty_identifier' });
      expect(calls).toHaveLength(0);
    });

    // Spec 140 DT4 — a non-blank audience id that is not UUID-shaped is refused
    // too, with its own code: no request, so never `DELETE /contacts/{email}`.
    it.each([
      ['a legacy-looking id', 'aud_1'],
      ['a UUID with surrounding spaces', ` ${AUD} `],
      ['a UUID missing a group', '0f8e7d6c-5b4a-4392-6e5d4c3b2a19'],
      ['a UUID with a non-hex digit', '0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a1g'],
      ['a path segment', `${AUD}/contacts`],
    ])('removeContactFromAudience refuses %s as invalid_identifier, with no request', async (_name, audienceId) => {
      const calls = stubWire(() => json(200, { object: 'contact', deleted: true }));
      const thrown = await resendBroadcastsGateway.removeContactFromAudience(audienceId, 'a@example.com').then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toMatchObject({ name: 'GatewayThrowable', kind: 'permanent', code: 'invalid_identifier' });
      // Spec 140 s3 review round 1 — the message reaches log lines: no id in it.
      expect((thrown as Error).message).not.toContain(audienceId.trim());
      expect(calls).toHaveLength(0);
    });

    // Spec 140 s4 plan review (sec L5) — the same guard on the two other calls
    // that put a segment id into the path: a falsy id makes `contacts.list` list
    // the WHOLE account (`GET /contacts`), and `segments.remove` / `segments.get`
    // put the id into the path unencoded.
    it.each([
      ['getAudienceContactCount, a legacy-looking id', () => resendBroadcastsGateway.getAudienceContactCount('aud_1')],
      ['getAudienceContactCount, a path segment', () => resendBroadcastsGateway.getAudienceContactCount(`${AUD}/x`)],
    ])('%s is refused as invalid_identifier, with no request', async (_name, run) => {
      const calls = stubWire(() => json(200, { object: 'list', has_more: false, data: [] }));
      await expect((run as () => Promise<unknown>)()).rejects.toMatchObject({
        name: 'GatewayThrowable',
        kind: 'permanent',
        code: 'invalid_identifier',
      });
      expect(calls).toHaveLength(0);
    });

    // PR #756 review round 2 (code-review #3) — `deleteAudience` on an id that is
    // not UUID-shaped: no such segment can exist at Resend (every id it returns
    // is a UUID), so the delete's goal is met. It resolves as already gone with NO
    // request and a warn naming the id's class, never the id, instead of a
    // permanent `invalid_identifier` the cleanup cron would hit every tick
    // forever (dev litter such as `aud_fake_N`). The detach and the count keep
    // refusing above: an id-less call there is account-wide.
    it.each([
      ['a legacy-looking id', 'aud_1', 'aud_prefixed'],
      ['old fake-gateway litter', 'aud_fake_3', 'aud_prefixed'],
      ['a path segment', `../contacts/${AUD}`, 'not_a_segment_id'],
    ])('deleteAudience on %s resolves as already gone, with no request', async (_name, audienceId, idClass) => {
      const warn = vi.spyOn(logger, 'warn');
      const calls = stubWire(() => json(200, { deleted: true }));
      await expect(resendBroadcastsGateway.deleteAudience(audienceId)).resolves.toBeUndefined();
      expect(calls).toHaveLength(0);
      const line = warn.mock.calls.find((c) => c[1] === 'resend.broadcasts.audience_id_not_a_segment');
      expect(line?.[0]).toEqual({ idClass });
      warn.mockRestore();
    });

    // Spec 140 s3 review round 1 (R1-K) — the SDK puts the email in the URL path
    // unencoded, so a character that ends or re-routes the path is refused
    // before any request, with a message that never carries the address.
    it.each([
      ['a slash', 'a/b@example.com'],
      ['a question mark', 'a?b@example.com'],
      ['a hash', 'a#b@example.com'],
      ['a percent sign', 'a%2fb@example.com'],
      ['a backslash', 'a\\b@example.com'],
    ])('removeContactFromAudience refuses an email with %s as invalid_identifier, with no request', async (_name, email) => {
      const calls = stubWire(() => json(200, { object: 'contact', deleted: true }));
      const thrown = await resendBroadcastsGateway.removeContactFromAudience(AUD, email).then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toMatchObject({ name: 'GatewayThrowable', kind: 'permanent', code: 'invalid_identifier' });
      expect((thrown as Error).message).not.toContain(email);
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

  // Spec 140 DT1 — Resend refuses a broadcast `name` over 70 code points. The
  // callers cap it (`resendDashboardName`); the gateway refuses a longer one
  // before any request, so a caller that forgets cannot reach Resend with it.
  describe('createBroadcast refuses a name over 70 code points, with no request', () => {
    const create = (name: string) =>
      resendBroadcastsGateway.createBroadcast({
        audienceId: 'aud_1',
        subject: 'Hello',
        htmlBody: '<p>hi</p>',
        fromName: 'SweCham',
        fromEmail: 'noreply@example.com',
        replyToEmail: 'office@example.com',
        broadcastNameForResendDashboard: name,
        tenantDisplayName: 'SweCham',
        locale: 'en',
      });

    it('71 code points → permanent broadcast_name_too_long, nothing sent', async () => {
      const calls = stubWire(() => json(201, { id: 'bc_1' }));
      const name = 'ก'.repeat(71);
      const thrown = await create(name).then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toMatchObject({ kind: 'permanent', code: 'broadcast_name_too_long' });
      // Spec 140 s3 review round 1 — the message reaches log lines: no name in it.
      expect((thrown as Error).message).not.toContain(name);
      expect(calls).toHaveLength(0);
    });

    it('70 code points, each two UTF-16 units → sent (counted by code point, not .length)', async () => {
      const calls = stubWire(() => json(201, { id: 'bc_1' }));
      await expect(create('😀'.repeat(70))).resolves.toEqual({ broadcastId: 'bc_1' });
      expect(calls).toHaveLength(1);
    });
  });

  it('a network failure that never clears is retryable, tagged network', async () => {
    vi.useFakeTimers();
    stubWire(() => {
      throw new TypeError('fetch failed');
    });
    const done = resendBroadcastsGateway.createAudience('probe').then(
      () => null,
      (e: { kind?: string; subKind?: string }) => ({ kind: e.kind, subKind: e.subKind }),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await done).toEqual({ kind: 'retryable', subKind: 'network' });
  });

  // Spec 140 s2a: a create is not retried (DL5a), so the retried network
  // failure is pinned on a DELETE.
  it('a network failure is retryable (network)', async () => {
    vi.useFakeTimers();
    const calls = stubWire((n) => {
      if (n === 1) throw new TypeError('fetch failed');
      return json(200, { object: 'segment', id: AUD, deleted: true });
    });
    const done = resendBroadcastsGateway.deleteAudience(AUD);
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ value: await done, attempts: calls.length }).toMatchInlineSnapshot(`
      {
        "attempts": 2,
        "value": undefined,
      }
    `);
  });

  // The maintainer's choice (30 Oct 2026, option A): a non-JSON error body
  // (an edge's or proxy's HTML page) is read as 4.8 read it, a transient 500
  // retried (inside the call budget since spec 140 s2a: 4 attempts in 10 s;
  // a create, 1), whatever status it carries. 6.35 started passing that
  // status through, so an HTML 404 read as "already gone" — on the erasure path
  // a false "already absent" in the Art. 30 record. Only a real Resend error
  // (JSON, a specific `name`) keeps its status.
  describe('a non-JSON error body is a transient 500, as on 4.8', () => {
    const html = (status: number) => () =>
      new Response(`<html>${status}</html>`, { status, headers: { 'content-type': 'text/html' } });
    it.each([
      ['retrieveBroadcast, HTML 404', 404, () => resendBroadcastsGateway.retrieveBroadcast('bc_1'), 4],
      ['deleteAudience, HTML 404', 404, () => resendBroadcastsGateway.deleteAudience(AUD), 4],
      ['deleteBroadcast, HTML 410', 410, () => resendBroadcastsGateway.deleteBroadcast('bc_1'), 4],
      ['removeContactFromAudience, HTML 404 (the erasure path)', 404, () =>
        resendBroadcastsGateway.removeContactFromAudience(AUD, 'a@example.com'), 4],
      ['removeContactFromAudience, HTML 410 (the erasure path)', 410, () =>
        resendBroadcastsGateway.removeContactFromAudience(AUD, 'a@example.com'), 4],
      ['sendBroadcast, HTML 409', 409, () => resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1'), 4],
      ['createAudience, HTML 413', 413, () => resendBroadcastsGateway.createAudience('probe'), 1],
      ['createAudience, HTML 429', 429, () => resendBroadcastsGateway.createAudience('probe'), 1],
    ])('%s', async (_name, status, run, attempts) => {
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
        attempts,
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
    it('createContactImport, a raw non-JSON 413 stays permanent (only 404 / 410 need Resend\'s JSON)', async () => {
      const calls = stubWire(html(413));
      await expect(resendBroadcastsGateway.createContactImport('aud_1', ['a@example.com'])).rejects.toMatchObject({
        kind: 'permanent',
      });
      expect(calls).toHaveLength(1);
    });

    it('removeContactFromAudience, a real JSON 404 is still already absent', async () => {
      stubWire(() => json(404, { statusCode: 404, name: 'not_found', message: 'Contact not found' }));
      await expect(resendBroadcastsGateway.removeContactFromAudience(AUD, 'a@example.com')).resolves.toEqual({
        kind: 'already_absent',
      });
    });
  });
});

// Spec 140 s2a (DL5a, DL8): through the real SDK, a create goes on the wire
// once, and every call hands `fetch` the AbortSignal that bounds it. The signal
// is read off the stubbed `fetch`'s own arguments, so the snapshots above stay
// as they are.
describe('Broadcasts gateway bounded calls on the wire (spec 140 s2a)', () => {
  const fetchInits = (): ReadonlyArray<RequestInit | undefined> =>
    (globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit | undefined]> } }).mock.calls.map(
      (c) => c[1],
    );
  const input = {
    audienceId: 'aud_1',
    subject: 'Hello',
    htmlBody: '<p>hi</p>',
    fromName: 'SweCham',
    fromEmail: 'noreply@example.com',
    replyToEmail: 'office@example.com',
    broadcastNameForResendDashboard: 'SweCham — Hello',
    tenantDisplayName: 'SweCham',
    locale: 'en',
  } satisfies CreateBroadcastInput;

  it.each([
    ['createAudience', () => resendBroadcastsGateway.createAudience('probe')],
    ['createBroadcast', () => resendBroadcastsGateway.createBroadcast(input)],
    ['createContactImport', () => resendBroadcastsGateway.createContactImport('aud_1', ['a@example.com'])],
  ])('%s answered 5xx sends one request', async (_name, run) => {
    vi.useFakeTimers();
    const calls = stubWire(() => json(500, { statusCode: 500, name: 'internal_server_error', message: 'boom' }));
    const done = (run() as Promise<unknown>).then(
      () => 'resolved',
      (e: { kind?: string }) => e.kind ?? 'threw',
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ outcome: await done, attempts: calls.length }).toEqual({ outcome: 'retryable', attempts: 1 });
  });

  it.each([
    ['createAudience', () => resendBroadcastsGateway.createAudience('probe')],
    ['createBroadcast', () => resendBroadcastsGateway.createBroadcast(input)],
    ['sendBroadcast', () => resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1')],
    ['getAudienceContactCount', () => resendBroadcastsGateway.getAudienceContactCount(AUD)],
    ['retrieveBroadcast', () => resendBroadcastsGateway.retrieveBroadcast('bc_1')],
    ['removeContactFromAudience', () => resendBroadcastsGateway.removeContactFromAudience(AUD, 'a@example.com')],
    ['listAudiences', () => resendBroadcastsGateway.listAudiences({ deadlineAt: farDeadline() })],
    ['deleteAudience', () => resendBroadcastsGateway.deleteAudience(AUD)],
    ['deleteBroadcast', () => resendBroadcastsGateway.deleteBroadcast('bc_1')],
  ])('%s: the signal reaches fetch', async (_name, run) => {
    stubWire(() => json(200, { object: 'list', id: 'x_1', has_more: false, data: [] }));
    await (run() as Promise<unknown>).catch(() => undefined);
    const inits = fetchInits();
    expect(inits.length).toBeGreaterThan(0);
    expect(inits.every((i) => i?.signal instanceof AbortSignal)).toBe(true);
  });
});

/**
 * Spec 140 slice 3, DT3 — the Resend error classes, keyed on the HTTP status
 * and then on Resend's `name` (both DOCUMENTED; 409 `resource_locked` was not
 * reproducible on the sink, research.md step 0.3):
 *   - 409 `resource_locked` → retryable / `locked` (another request is updating
 *     the resource; nothing was refused); any other 409 keeps
 *     `idempotency_conflict`;
 *   - 429 `daily_quota_exceeded` / `monthly_quota_exceeded` → permanent (it does
 *     not clear inside a call, nor inside FR-021's hour), the code kept;
 *   - 429 `rate_limit_exceeded`, or a 429 with no name → retryable / `api`.
 * The raw once readers keep 409 → `other` (undecided), outside DT3.
 */
describe('DT3 — Resend error classes (spec 140 slice 3)', () => {
  const locked = () =>
    json(409, { statusCode: 409, name: 'resource_locked', message: 'Another request is already updating this resource' });
  const refused422 = () =>
    json(422, { statusCode: 422, name: 'validation_error', message: 'Only draft broadcasts can be sent or scheduled' });
  const settle = (p: Promise<unknown>) =>
    p.then(
      () => ({ outcome: 'resolved', subKind: null, code: null }),
      (e: { kind?: string; subKind?: string; code?: string }) => ({
        outcome: e.kind ?? 'threw',
        subKind: e.subKind ?? null,
        code: e.code ?? null,
      }),
    );
  const createInput = {
    audienceId: 'aud_1',
    subject: 'Hello',
    htmlBody: '<p>hi</p>',
    fromName: 'SweCham',
    fromEmail: 'noreply@example.com',
    replyToEmail: 'office@example.com',
    broadcastNameForResendDashboard: 'SweCham — Hello',
    tenantDisplayName: 'SweCham',
    locale: 'en',
  } satisfies CreateBroadcastInput;

  it('sendBroadcast: a 409 resource_locked is retried, and a retry that lands resolves', async () => {
    vi.useFakeTimers();
    const calls = stubWire((n) => (n === 1 ? locked() : json(200, { id: 'bc_1' })));
    const done = settle(resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1'));
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ ...(await done), attempts: calls.length }).toEqual({ outcome: 'resolved', subKind: null, code: null, attempts: 2 });
  });

  // The send arm's "409 then 422": the 422 is permanent and leaves the bounded
  // call at once; the caller probes it (`probeRefusedSend`) before believing it.
  it('sendBroadcast: 409 resource_locked, then 422 → the 422 is thrown permanent out of the bounded call', async () => {
    vi.useFakeTimers();
    const calls = stubWire((n) => (n === 1 ? locked() : refused422()));
    const done = settle(resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1'));
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ ...(await done), attempts: calls.length }).toEqual({
      outcome: 'permanent',
      subKind: null,
      code: 'validation_error',
      attempts: 2,
    });
  });

  it.each([
    ['retrieveBroadcast', () => resendBroadcastsGateway.retrieveBroadcast('bc_1')],
    ['deleteBroadcast', () => resendBroadcastsGateway.deleteBroadcast('bc_1')],
    ['sendBroadcast', () => resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1')],
  ])('%s: a 409 resource_locked that never clears is retryable / locked, inside the call budget', async (_name, run) => {
    vi.useFakeTimers();
    const calls = stubWire(locked);
    const done = settle(run() as Promise<unknown>);
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ ...(await done), attempts: calls.length }).toEqual({ outcome: 'retryable', subKind: 'locked', code: null, attempts: 4 });
  });

  it('createBroadcast: a 409 resource_locked is retryable / locked, one request (a create retries a 429 only)', async () => {
    vi.useFakeTimers();
    const calls = stubWire(locked);
    const done = settle(resendBroadcastsGateway.createBroadcast(createInput));
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ ...(await done), attempts: calls.length }).toEqual({ outcome: 'retryable', subKind: 'locked', code: null, attempts: 1 });
  });

  it.each(['daily_quota_exceeded', 'monthly_quota_exceeded'])(
    'sendBroadcast: a 429 %s is permanent with its code, one request',
    async (name) => {
      vi.useFakeTimers();
      const calls = stubWire(() => json(429, { statusCode: 429, name, message: 'quota reached' }));
      const done = settle(resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1'));
      await vi.advanceTimersByTimeAsync(40_000);
      expect({ ...(await done), attempts: calls.length }).toEqual({ outcome: 'permanent', subKind: null, code: name, attempts: 1 });
    },
  );

  // `throwImportError` goes through `classifyResendError`, so the import calls inherit DT3.
  it.each(['daily_quota_exceeded', 'monthly_quota_exceeded'])(
    'createContactImport: a 429 %s is permanent with its code, one request',
    async (name) => {
      vi.useFakeTimers();
      const calls = stubWire(() => json(429, { statusCode: 429, name, message: 'quota reached' }));
      const done = settle(resendBroadcastsGateway.createContactImport('aud_1', ['a@example.com']));
      await vi.advanceTimersByTimeAsync(40_000);
      expect({ ...(await done), attempts: calls.length }).toEqual({ outcome: 'permanent', subKind: null, code: name, attempts: 1 });
    },
  );

  it.each([
    ['rate_limit_exceeded', { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }],
    ['with no name', { statusCode: 429, message: 'Too many requests' }],
    ['with a name this build does not know', { statusCode: 429, name: 'some_new_limit', message: 'Slow down' }],
  ])('retrieveBroadcast: a 429 %s stays retryable / api', async (_label, body) => {
    vi.useFakeTimers();
    const calls = stubWire(() => json(429, body));
    const done = settle(resendBroadcastsGateway.retrieveBroadcast('bc_1'));
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ ...(await done), attempts: calls.length }).toEqual({ outcome: 'retryable', subKind: 'api', code: null, attempts: 4 });
  });

  it('sendBroadcast: any other 409 keeps idempotency_conflict, one request', async () => {
    vi.useFakeTimers();
    const calls = stubWire(() =>
      json(409, { statusCode: 409, name: 'invalid_idempotent_request', message: 'Same key, different payload' }),
    );
    const done = settle(resendBroadcastsGateway.sendBroadcast('bc_1', 'idem-key-1'));
    await vi.advanceTimersByTimeAsync(40_000);
    expect({ ...(await done), attempts: calls.length }).toEqual({
      outcome: 'idempotency_conflict',
      subKind: null,
      code: null,
      attempts: 1,
    });
  });

  // Deliberately outside DT3: under the erasure cascade's row lock a 409 decides
  // nothing, so the raw readers keep it `other` (undecided). Do not "fix" it.
  it.each([
    ['deleteBroadcastOnce', () => resendBroadcastsGateway.deleteBroadcastOnce('bc_1')],
    ['retrieveBroadcastOnce', () => resendBroadcastsGateway.retrieveBroadcastOnce('bc_1')],
  ])('%s: a JSON 409 resource_locked stays other', async (_name, run) => {
    stubWire(locked);
    await expect(run()).resolves.toEqual({ kind: 'other' });
  });
});

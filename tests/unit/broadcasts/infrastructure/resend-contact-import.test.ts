/**
 * T086 (108 US5) — the Resend **Contacts Import** gateway methods.
 *
 * These two calls replace the per-contact push. `addContactsToAudience` is a
 * serial `await` loop at a measured ~2.08 req/s, so ~623 contacts is all one
 * 300 s function can drain; `POST /contacts/imports` takes the whole list in
 * one multipart request in ~412 ms **regardless of size** (T145, 2026-09-08).
 * Every mechanism this codebase grew to work around the loop — split
 * thresholds, per-batch manifests, one-wave dispatch, cross-tick drift guards
 * — exists only because the push was per-contact.
 *
 * The SDK (`resend@4.8`) has no `contacts.imports`, so the adapter issues a raw
 * multipart `fetch`. That makes the REQUEST SHAPE the contract, and this file
 * pins it **by value**, not by round-tripping through the code that builds it:
 *
 *   - `segments` MUST be `[{ id }]` — an array of OBJECTS. This repo's own
 *     `contracts/broadcast-audience.md` § 4 specified `[<id>]` for a year and
 *     Resend answers **422** to it: *"The `segments` must be an array of
 *     objects with a UUID `id` field."* Worse, the shape two earlier probes
 *     used, `audience_id`, is **accepted and silently ignored** — which is how
 *     "the import does not attach to an audience" reached the spec as a fact.
 *     A test that builds the expectation with the same helper as the code
 *     would have agreed with all three spellings.
 *   - `column_map` MUST be `{"email":"email"}` — the CSV carries ONE column.
 *     Never `unsubscribed`: research V2 measured that `on_conflict=upsert`
 *     PRESERVES a contact's unsubscribed flag when the column is absent, and
 *     that is the only reason `upsert` is legal here (GDPR Art. 21 / PDPA §32).
 *     A future column-map that adds it would silently resurrect people.
 *   - `on_conflict` MUST be `upsert` — the same measurement, and what makes a
 *     re-submitted import idempotent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

const AUDIENCE_ID = '11111111-2222-4333-8444-555555555555';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly fields: Record<string, string>;
  readonly fileText: string;
}

const captured: CapturedRequest[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records what the adapter actually put on the wire, then answers `respond`. */
function stubFetch(respond: (call: number) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const fields: Record<string, string> = {};
      let fileText = '';
      if (init?.body instanceof FormData) {
        for (const [k, v] of init.body.entries()) {
          if (v instanceof Blob) fileText = await v.text();
          else fields[k] = String(v);
        }
      }
      const headers = new Headers(init?.headers ?? {});
      captured.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        fields,
        fileText,
      });
      return respond(captured.length);
    }),
  );
}

beforeEach(() => {
  captured.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createContactImport — the multipart contract (T086)', () => {
  it('submits ONE multipart request with the exact field shape Resend accepts', async () => {
    stubFetch(() => jsonResponse(201, { object: 'contact_import', id: 'imp_abc' }));

    const result = await resendBroadcastsGateway.createContactImport(AUDIENCE_ID, [
      'a@example.com',
      'b@example.com',
    ]);

    expect(result).toEqual({ importId: 'imp_abc' });
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.resend.com/contacts/imports');
    expect(req.authorization).toMatch(/^Bearer /);

    // The three fields, pinned by value. `segments` as an array of OBJECTS is
    // the whole finding of T145 — `[<id>]` is a 422 and `audience_id` is
    // accepted-and-ignored.
    expect(JSON.parse(req.fields['segments']!)).toEqual([{ id: AUDIENCE_ID }]);
    expect(JSON.parse(req.fields['column_map']!)).toEqual({ email: 'email' });
    expect(req.fields['on_conflict']).toBe('upsert');
  });

  it('renders a CSV with an email header and one address per line — and no other column', async () => {
    stubFetch(() => jsonResponse(201, { id: 'imp_csv' }));

    await resendBroadcastsGateway.createContactImport(AUDIENCE_ID, [
      'one@example.com',
      'two@example.com',
      'three@example.com',
    ]);

    const csv = captured[0]!.fileText;
    expect(csv.split(/\r?\n/).filter(Boolean)).toEqual([
      'email',
      'one@example.com',
      'two@example.com',
      'three@example.com',
    ]);
    // An `unsubscribed` column would clear the flag on every upsert. Research
    // V2 proved the flag survives only because the column is absent.
    expect(csv).not.toContain('unsubscribed');
  });

  it('a 4xx is PERMANENT — the contact cap answers this way and no retry can help', async () => {
    stubFetch(() =>
      jsonResponse(422, {
        statusCode: 422,
        name: 'validation_error',
        message: 'You have reached your contact limit',
      }),
    );

    await expect(
      resendBroadcastsGateway.createContactImport(AUDIENCE_ID, ['a@example.com']),
    ).rejects.toMatchObject({ kind: 'permanent' });
    // One attempt, not the retry schedule: retrying a 4xx burns the very quota
    // whose exhaustion caused it.
    expect(captured).toHaveLength(1);
  });

  it('a 429 is RETRYABLE and the backoff runs before it gives up', async () => {
    stubFetch(() =>
      jsonResponse(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'slow down' }),
    );

    await expect(
      resendBroadcastsGateway.createContactImport(AUDIENCE_ID, ['a@example.com']),
    ).rejects.toMatchObject({ kind: 'retryable' });
    expect(captured.length).toBeGreaterThan(1);
  }, 30_000);
});

describe('getContactImport — the completion signal (T086)', () => {
  it('returns status and counts verbatim, so the use case can apply the completion rule', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        object: 'contact_import',
        id: 'imp_abc',
        status: 'completed',
        counts: { total: 3, created: 2, updated: 1, skipped: 0, failed: 0 },
      }),
    );

    const out = await resendBroadcastsGateway.getContactImport('imp_abc');

    expect(captured[0]!.url).toBe('https://api.resend.com/contacts/imports/imp_abc');
    expect(captured[0]!.method).toBe('GET');
    expect(out).toEqual({
      status: 'completed',
      counts: { total: 3, created: 2, updated: 1, skipped: 0, failed: 0 },
    });
  });

  it('a COMPLETED import that processed nothing is reported honestly, not smoothed away', async () => {
    // Observed in the wild: one import in five returned exactly this and
    // attached no contacts (research § R9 V2 (c)). The gateway must not paper
    // over it — the caller's completion rule (`total === resolvedCount`) is the
    // thing standing between that and a send to an empty audience.
    stubFetch(() =>
      jsonResponse(200, {
        status: 'completed',
        counts: { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
      }),
    );

    const out = await resendBroadcastsGateway.getContactImport('imp_zero');

    expect(out.status).toBe('completed');
    expect(out.counts.total).toBe(0);
  });

  it('missing counts default to zero rather than undefined, so arithmetic on them cannot silently pass', async () => {
    // A `pending` import has no counts yet. Returning `undefined` would make
    // `created + updated + skipped === total` evaluate to NaN === NaN → false,
    // which happens to be safe here — but only by accident, and the next
    // comparison written against it might not be.
    stubFetch(() => jsonResponse(200, { status: 'pending' }));

    const out = await resendBroadcastsGateway.getContactImport('imp_pending');

    expect(out.status).toBe('pending');
    expect(out.counts).toEqual({ total: 0, created: 0, updated: 0, skipped: 0, failed: 0 });
  });
});

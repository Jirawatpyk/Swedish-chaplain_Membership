// @vitest-environment node
/**
 * T086 (108 US5) — the Resend **Contacts Import** gateway methods.
 *
 * **Runs under the `node` environment, not the project default `jsdom`.** The
 * adapter builds a `FormData` carrying a `Blob`, and reading that Blob back in
 * jsdom goes through its `FileReader` shim, which never settles here — every
 * case hung to the 30 s harness timeout and looked like a broken adapter. This
 * is Node-side code talking to an HTTP API; jsdom was never the right host for
 * it. (Sibling symptom of the repo's fake-timer trap: a 30 s timeout is the
 * harness, not the component.)
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
  /**
   * 108 Phase 9 review S29 — the multipart FIELD NAME and FILENAME were
   * unpinned. The capture below keys the file part on `v instanceof Blob`, so
   * renaming the form key from `file` to anything else still populated
   * `fileText` and every assertion in this file passed while Resend 422'd.
   */
  readonly fileFieldName: string | null;
  readonly fileName: string | null;
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
      let fileFieldName: string | null = null;
      let fileName: string | null = null;
      if (init?.body instanceof FormData) {
        for (const [k, v] of init.body.entries()) {
          if (v instanceof Blob) {
            fileText = await v.text();
            fileFieldName = k;
            fileName = v instanceof File ? v.name : null;
          } else fields[k] = String(v);
        }
      }
      const headers = new Headers(init?.headers ?? {});
      captured.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        fields,
        fileText,
        fileFieldName,
        fileName,
      });
      return respond(captured.length);
    }),
  );
}

beforeEach(() => {
  // `tests/setup.ts` installs fake timers globally. `withRetry` awaits a real
  // `setTimeout` between attempts, so without this every case here hangs to the
  // 30 s harness timeout and looks like a broken adapter rather than a broken
  // clock. (Known trap in this repo — a 30 s timeout is the harness, not the
  // component under test.)
  vi.useRealTimers();
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

  it('a 429 is RETRYABLE — the next attempt succeeds and the import is NOT resubmitted twice on success', async () => {
    // Deliberately "429 then 201" rather than "429 forever": exhausting the
    // 1/2/4/8/16 s schedule costs 31 real seconds, and the exhaustion path is
    // already pinned for the sibling methods in
    // `resend-broadcasts-gateway-contract.test.ts`. What is specific to THIS
    // method is that a rate-limited first attempt must not leave a half-made
    // import behind — `upsert` is what makes the second attempt harmless.
    stubFetch((call) =>
      call === 1
        ? jsonResponse(429, {
            statusCode: 429,
            name: 'rate_limit_exceeded',
            message: 'slow down',
          })
        : jsonResponse(201, { id: 'imp_after_429' }),
    );

    const result = await resendBroadcastsGateway.createContactImport(AUDIENCE_ID, [
      'a@example.com',
    ]);

    expect(result).toEqual({ importId: 'imp_after_429' });
    expect(captured).toHaveLength(2);
    // Both attempts carried the same audience and the same single row, so the
    // upsert cannot duplicate anyone.
    expect(captured[0]!.fileText).toBe(captured[1]!.fileText);
    expect(captured[1]!.fields['on_conflict']).toBe('upsert');
  }, 15_000);
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

  /**
   * S29 — the multipart envelope, pinned BY VALUE like `column_map` and
   * `on_conflict` already are.
   *
   * The capture harness keys the file part on `v instanceof Blob`, so a rename
   * of the form key would still fill `fileText` and leave every other assertion
   * in this file green while Resend rejected the request. Same class as the
   * three wrong `segments` spellings that made the by-value pinning necessary
   * in the first place.
   */
  it('pins the multipart file field name and filename', async () => {
    stubFetch(() => jsonResponse(200, { id: 'imp_env' }));

    await resendBroadcastsGateway.createContactImport(AUDIENCE_ID, ['a@example.com']);

    expect(captured[0]!.fileFieldName).toBe('file');
    expect(captured[0]!.fileName).toBe('audience.csv');
  });

  /**
   * S16 — boundary validation for CSV control characters.
   *
   * `EmailLower` reads like a guarantee and is not: `unsafeBrandEmailLower` is
   * a bare `return raw as EmailLower`, and it feeds every path into this method.
   * An address carrying a newline injects an extra CSV row, creating a contact
   * that was never in the resolved list. The completion rule catches that
   * downstream — but only AFTER the contact exists at Resend, which makes it a
   * backstop rather than a boundary.
   */
  it('refuses an address containing a newline before anything reaches Resend', async () => {
    stubFetch(() => jsonResponse(200, { id: 'imp_never' }));

    await expect(
      resendBroadcastsGateway.createContactImport(AUDIENCE_ID, [
        'ok@example.com',
        'evil@example.com\ninjected@attacker.example',
      ]),
    ).rejects.toMatchObject({ kind: 'permanent' });

    // Nothing was sent. A refusal that still made the request would leave the
    // injected contact behind, which is the whole point of moving this earlier.
    expect(captured).toHaveLength(0);
  });

  it.each([
    ['carriage return', 'a@example.com\rx@example.com'],
    ['comma', 'a@example.com,x@example.com'],
    ['double quote', 'a"@example.com'],
  ])('refuses an address containing a %s', async (_label, bad) => {
    stubFetch(() => jsonResponse(200, { id: 'imp_never' }));

    await expect(
      resendBroadcastsGateway.createContactImport(AUDIENCE_ID, [bad]),
    ).rejects.toMatchObject({ kind: 'permanent' });
    expect(captured).toHaveLength(0);
  });

  it('POSITIVE CONTROL — ordinary addresses still pass the boundary', async () => {
    // Without this, the four refusals above pass just as happily if the filter
    // rejected everything. `+` and `-` are legal in a local part and MUST NOT be
    // caught: plus-addressing is a real, common address shape.
    stubFetch(() => jsonResponse(200, { id: 'imp_ok' }));

    const out = await resendBroadcastsGateway.createContactImport(AUDIENCE_ID, [
      'a@example.com',
      'first.last+tag@example.co.th',
      'o-brien@example.org',
    ]);

    expect(out.importId).toBe('imp_ok');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.fileText).toBe(
      'email\na@example.com\nfirst.last+tag@example.co.th\no-brien@example.org\n',
    );
  });

  /**
   * S23 — `importId` arrives as `body.id` from the provider, is persisted
   * without validation, and goes into a URL PATH. `fetch` normalises `..`
   * segments, so an id carrying one would change which endpoint is called.
   */
  it('URL-encodes the import id rather than interpolating it raw', async () => {
    stubFetch(() => jsonResponse(200, { status: 'pending' }));

    await resendBroadcastsGateway.getContactImport('../audiences/evil');

    const url = captured[0]!.url;
    // `encodeURIComponent` leaves `.` alone — it is unreserved — and encodes the
    // SEPARATOR. That is the part that matters: without a `/` there is no path
    // to traverse, so the id stays one path segment however many dots it holds.
    expect(url).toContain('%2Faudiences%2Fevil');
    expect(url).not.toContain('/audiences/evil');
    expect(url.startsWith('https://api.resend.com/contacts/imports/')).toBe(true);
  });
});

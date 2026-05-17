/**
 * T090 — Contract test: POST /api/admin/events/import (CSV import)
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/contracts/csv-import-api.md
 *   - specs/012-eventcreate-integration/contracts/admin-events-api.md
 *     § POST /api/admin/events/import (envelope shapes)
 *   - FR-026 (drag-drop + preview + remap), FR-027 (webhook-equivalence
 *     same matching + quota), FR-028 (result summary), FR-029 (row-level
 *     idempotency), FR-035 (RBAC + surface-disclosure 404 + audit),
 *     SC-006 (1k rows / <60s).
 *
 * Exercises every HTTP outcome (200 / 400 header / 400 missing_file_field
 * / 400 invalid_multipart / 413 file-too-large pre-parse / 413 post-parse
 * chunked / 415 unsupported-media-type / 429 rate-limited / 504 timeout /
 * 500 unexpected / 403 manager / 404 member / 404 kill-switch off) with
 * dependencies mocked at module-boundary so no DB, no Upstash, no
 * actual CSV parser is hit. Pattern mirrors
 * `tests/contract/events/admin-integration-eventcreate-api.test.ts`
 * + `tests/contract/events/admin-events-api.test.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock seams — composition adapter (T095) + auth + tenant + standalone audit.
// ---------------------------------------------------------------------------

const runImportCsvMock = vi.fn();
const csvImportRateLimitCheckMock = vi.fn();
const lookupEventByIdTimingSafeMock = vi.fn();
const getCurrentSessionMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();
const emitStandaloneMock = vi.fn();

vi.mock('@/lib/events-csv-import-deps', () => ({
  runImportCsv: (...args: unknown[]) => runImportCsvMock(...args),
  csvImportRateLimitCheck: (...args: unknown[]) =>
    csvImportRateLimitCheckMock(...args),
  // F6.1 (Round 1 Phase B): added by T023 — route now performs a
  // timing-safe event lookup BEFORE dispatch.
  lookupEventByIdTimingSafe: (...args: unknown[]) =>
    lookupEventByIdTimingSafeMock(...args),
}));

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: (...args: unknown[]) =>
    resolveTenantFromRequestMock(...args),
}));

vi.mock('@/modules/events', async () => {
  const actual = await vi.importActual<typeof import('@/modules/events')>(
    '@/modules/events',
  );
  return {
    ...actual,
    makeStandaloneAuditDeps: () => ({
      emitStandalone: (...args: unknown[]) => emitStandaloneMock(...args),
    }),
  };
});

// Feature flag: route handler gates on `env.features.f6EventCreate`.
vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      features: {
        ...actual.env.features,
        f6EventCreate: true,
      },
      tenant: { slug: 'test-swecham' },
    },
  };
});

const TENANT_SLUG = 'test-swecham';
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';

const ADMIN_SESSION = {
  session: { id: 'sess-admin', userId: ADMIN_USER_ID } as unknown,
  user: { id: ADMIN_USER_ID, role: 'admin' as const, email: 'admin@test' },
};
const MANAGER_SESSION = {
  session: { id: 'sess-manager', userId: 'mgr' } as unknown,
  user: { id: 'mgr', role: 'manager' as const, email: 'mgr@test' },
};
const MEMBER_SESSION = {
  session: { id: 'sess-member', userId: 'mem' } as unknown,
  user: { id: 'mem', role: 'member' as const, email: 'mem@test' },
};

const VALID_CSV =
  'event_external_id,event_name,event_start,attendee_email,attendee_name\n' +
  'event_001,Midsummer 2026,2026-06-21T18:00:00+07:00,jane@example.com,Jane Andersson\n';

// Staff-review R3 follow-up (2026-05-16): pre-warm the import route
// module. Prior coverage run measured this file's first test at
// 29.3s (just under the 30s testTimeout) — under additional
// instrumentation + parallel CPU contention it intermittently
// timed out. `beforeAll` amortises the cold-import into a single
// hook (which now has its own 30s hookTimeout per vitest.config.ts).
beforeAll(async () => {
  await loadImportRoute();
});

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  getCurrentSessionMock.mockResolvedValue(ADMIN_SESSION);
  csvImportRateLimitCheckMock.mockResolvedValue({
    success: true,
    resetAtUnixMs: Date.now() + 3_600_000,
  });
  emitStandaloneMock.mockResolvedValue({ ok: true, value: 'audit-id' });
  // F6.1 (Round 1 Phase B): default mock returns 'found' so Phase 7
  // outcome tests reach the use-case dispatch path. Individual tests
  // override for not_found / wrong_tenant scenarios.
  lookupEventByIdTimingSafeMock.mockResolvedValue({
    kind: 'found',
    event: {
      eventId: '11111111-2222-4333-8444-555555555555',
      externalId: 'event-iso',
      name: 'Phase 7 Test Event',
      startDate: new Date('2026-06-21T18:00:00+07:00'),
      category: null,
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Dynamic route loader
// ---------------------------------------------------------------------------

async function loadImportRoute() {
  try {
    return (await import('@/app/api/admin/events/import/route')) as {
      POST: (req: NextRequest) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`csv-import route load failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Request builder — multipart with optional file part.
// ---------------------------------------------------------------------------

interface BuildRequestOpts {
  /** Defaults to a valid 1-row CSV body. */
  readonly csvBody?: string;
  /** Defaults to `multipart/form-data; boundary=---test`. */
  readonly contentType?: string;
  /** When provided, sets Content-Length header (used for 413 pre-parse). */
  readonly contentLengthOverride?: string;
  /** When true, omit the `file` field entirely (used for missing_file_field). */
  readonly omitFileField?: boolean;
  /** When true, replace the entire body with non-multipart garbage. */
  readonly malformedBody?: boolean;
}

function buildRequest(opts: BuildRequestOpts = {}): NextRequest {
  const url = 'http://test/api/admin/events/import';
  const boundary = `test-boundary-${Math.random().toString(36).slice(2)}`;

  // Malformed-body path: send raw bytes that don't match any
  // multipart structure. formData() will reject.
  if (opts.malformedBody === true) {
    const headers: Record<string, string> = {
      'Content-Type':
        opts.contentType ?? `multipart/form-data; boundary=${boundary}`,
    };
    if (opts.contentLengthOverride !== undefined) {
      headers['Content-Length'] = opts.contentLengthOverride;
    }
    return new NextRequest(url, {
      method: 'POST',
      headers,
      body: 'this-is-not-valid-multipart',
    });
  }

  // Build multipart body as a manually-encoded Uint8Array (CRLF-delimited
  // per RFC 7578). Node undici's Request.formData() can parse this
  // reliably when given binary bytes; passing a `FormData` instance
  // directly to the Request ctor in vitest's Node runtime stalls the
  // body stream, and passing a `string` body upstream sometimes leaves
  // the CSV body's `\n` characters mismatched against the multipart
  // CRLF-strict envelope.
  //
  // The CSV content (which contains its own `\n` newlines as data) is
  // appended VERBATIM as bytes between the multipart CRLF headers —
  // the multipart parser delimits on `--boundary`, not on newline.
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  if (opts.omitFileField === true) {
    parts.push(
      enc.encode(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="other_field"',
          '',
          'not-a-file',
          '',
        ].join('\r\n'),
      ),
    );
  } else {
    parts.push(
      enc.encode(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="test.csv"',
          'Content-Type: text/csv',
          '',
          '',
        ].join('\r\n'),
      ),
    );
    parts.push(enc.encode(opts.csvBody ?? VALID_CSV));
    parts.push(enc.encode('\r\n'));
  }
  // F6.1 (Round 1 Phase B): route now requires `event_id` form field.
  // Phase 7 tests must include a valid UUID + a successful
  // `lookupEventByIdTimingSafe` mock for the use-case mocks to run.
  parts.push(
    enc.encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="event_id"',
        '',
        '11111111-2222-4333-8444-555555555555',
        '',
      ].join('\r\n'),
    ),
  );
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const totalLength = parts.reduce((n, p) => n + p.byteLength, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.byteLength;
  }

  const headers: Record<string, string> = {
    'Content-Type':
      opts.contentType ?? `multipart/form-data; boundary=${boundary}`,
  };
  if (opts.contentLengthOverride !== undefined) {
    headers['Content-Length'] = opts.contentLengthOverride;
  }
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('T090 — POST /api/admin/events/import (CSV import contract)', () => {
  describe('200 OK — happy path with full result summary', () => {
    it('returns rowsProcessed / rowsAlreadyImported / eventsCreated / eventsUpdated / matchCounts / errorRows / durationMs', async () => {
      runImportCsvMock.mockResolvedValue({
        kind: 'completed',
        summary: {
          rowsProcessed: 95,
          rowsAlreadyImported: 5,
          eventsCreated: 3,
          eventsUpdated: 2,
          matchCounts: {
            member_contact: 50,
            member_domain: 20,
            member_fuzzy: 15,
            non_member: 8,
            unmatched: 7,
          },
          errorRows: [],
          durationMs: 12_345,
        },
      });

      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // F6.1 envelope wraps summary under `body.summary`.
      const summary = body['summary'] as Record<string, unknown>;
      expect(summary['rowsProcessed']).toBe(95);
      expect(summary['rowsAlreadyImported']).toBe(5);
      expect(summary['eventsCreated']).toBe(3);
      expect(summary['eventsUpdated']).toBe(2);
      expect(summary['matchCounts']).toEqual({
        member_contact: 50,
        member_domain: 20,
        member_fuzzy: 15,
        non_member: 8,
        unmatched: 7,
      });
      expect(summary['errorRows']).toEqual([]);
      expect(summary['durationMs']).toBe(12_345);
    });

    it('R7.B1 / Staff R2 R030 — safetyNetFailedOpen=true surfaces in completed 200 response body for admin UX', async () => {
      runImportCsvMock.mockResolvedValue({
        kind: 'completed',
        recordId: 'rec-r7-b1',
        sourceFormat: 'eventcreate_csv',
        errorCsvAvailable: false,
        historyPersisted: true,
        auditCompletionEmitted: true,
        safetyNetFailedOpen: true,
        summary: {
          rowsProcessed: 10,
          rowsAlreadyImported: 0,
          eventsCreated: 1,
          eventsUpdated: 0,
          matchCounts: {
            member_contact: 0,
            member_domain: 0,
            member_fuzzy: 0,
            non_member: 5,
            unmatched: 5,
          },
          errorRows: [],
          durationMs: 1000,
        },
      });
      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { safetyNetFailedOpen?: boolean };
      expect(body.safetyNetFailedOpen).toBe(true);
    });

    it('R7.B1 — safetyNetFailedOpen=false (happy path) surfaces explicit false (not undefined)', async () => {
      runImportCsvMock.mockResolvedValue({
        kind: 'completed',
        recordId: 'rec-r7-b1-happy',
        sourceFormat: 'eventcreate_csv',
        errorCsvAvailable: false,
        historyPersisted: true,
        auditCompletionEmitted: true,
        safetyNetFailedOpen: false,
        summary: {
          rowsProcessed: 5,
          rowsAlreadyImported: 0,
          eventsCreated: 0,
          eventsUpdated: 1,
          matchCounts: {
            member_contact: 3,
            member_domain: 0,
            member_fuzzy: 0,
            non_member: 1,
            unmatched: 1,
          },
          errorRows: [],
          durationMs: 500,
        },
      });
      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { safetyNetFailedOpen?: boolean };
      expect(body.safetyNetFailedOpen).toBe(false);
    });

    it('still 200 when some rows failed — errorRows[] surfaces row numbers + reasons', async () => {
      runImportCsvMock.mockResolvedValue({
        kind: 'completed',
        summary: {
          rowsProcessed: 47,
          rowsAlreadyImported: 0,
          eventsCreated: 1,
          eventsUpdated: 0,
          matchCounts: {
            member_contact: 30,
            member_domain: 10,
            member_fuzzy: 5,
            non_member: 1,
            unmatched: 1,
          },
          errorRows: [
            { rowNumber: 8, reason: 'attendee_email is not a valid email' },
            { rowNumber: 23, reason: 'unterminated quoted field at column 3' },
            { rowNumber: 47, reason: 'event_start is required' },
          ],
          durationMs: 4_200,
        },
      });

      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());

      expect(res.status).toBe(200);
      // F6.1 envelope wraps summary under `body.summary`.
      const body = (await res.json()) as {
        summary: { errorRows: unknown[] };
      };
      expect(body.summary.errorRows).toHaveLength(3);
    });
  });

  describe('400 — invalid header / missing file / invalid multipart', () => {
    it('400 csv-header-invalid — RFC 7807 problem with missingColumns[]', async () => {
      runImportCsvMock.mockResolvedValue({
        kind: 'invalid_header',
        missingColumns: ['attendee_email', 'event_start'],
      });

      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest({ csvBody: 'event_external_id\nevent_001\n' }));

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['type']).toMatch(/csv-header-invalid/);
      expect(body['status']).toBe(400);
      expect(body['missingColumns']).toEqual([
        'attendee_email',
        'event_start',
      ]);
    });

    it('400 missing_file_field — multipart without `file` part', async () => {
      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest({ omitFileField: true }));

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body['type'])).toMatch(
        /(missing-file|missing_file_field|file-required)/,
      );
      // Use-case MUST NOT be called when the file part is missing
      expect(runImportCsvMock).not.toHaveBeenCalled();
    });

    it('400 invalid_multipart — formData parse fails', async () => {
      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest({ malformedBody: true }));

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body['type'])).toMatch(/(invalid-multipart|invalid_multipart)/);
      expect(runImportCsvMock).not.toHaveBeenCalled();
    });
  });

  describe('413 file-too-large', () => {
    it('413 pre-parse — Content-Length header > 5 MiB rejected before parse', async () => {
      const { POST } = await loadImportRoute();
      const sixMiB = String(6 * 1024 * 1024);
      const res = await POST(
        buildRequest({ contentLengthOverride: sixMiB }),
      );

      expect(res.status).toBe(413);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body['type'])).toMatch(/(too-large|file_too_large)/);
      expect(runImportCsvMock).not.toHaveBeenCalled();
    });

    it('413 post-parse — chunked-transfer upload exceeding 5 MiB rejected after multipart parse (R-S03 defence-in-depth)', async () => {
      // Simulate chunked-transfer upload: client omits Content-Length
      // (HTTP/1.1 chunked encoding) so the pre-parse check at
      // route.ts:Content-Length never fires. The post-parse guard at
      // route.ts inspects `arrayBuffer.byteLength > MAX_BYTES` and
      // must reject the oversized body BEFORE invoking the use-case.
      //
      // Implementation note: in undici, omitting Content-Length on a
      // body sized > 5 MiB is the natural chunked-transfer code path.
      // We construct a multipart body whose CSV part exceeds the limit
      // by padding with valid-ascii data rows (so the multipart
      // parser succeeds; the size check is the only gate that should
      // fail). The Content-Length header is intentionally NOT set
      // via `contentLengthOverride`.
      const { POST } = await loadImportRoute();

      // Build a CSV body > 5 MiB. Each row is ~90 bytes; ~58000 rows
      // ≈ 5.2 MiB. CSV is structurally valid so parser would accept it
      // — only size check should reject.
      const header =
        'event_external_id,event_name,event_start,attendee_email,attendee_name\n';
      const rowTemplate =
        'event_big_NNN,Big Test,2026-06-21T18:00:00+07:00,big_NNN@example.com,Big Attendee NNN\n';
      const ROWS = 60_000;
      const csvParts: string[] = [header];
      for (let i = 0; i < ROWS; i++) {
        csvParts.push(rowTemplate.replace(/NNN/g, String(i)));
      }
      const csvBody = csvParts.join('');
      // Sanity: ensure the test fixture is genuinely > 5 MiB so the
      // assertion isn't a false negative if the row template ever
      // changes size.
      expect(new TextEncoder().encode(csvBody).byteLength).toBeGreaterThan(
        5 * 1024 * 1024,
      );

      const res = await POST(buildRequest({ csvBody }));

      expect(res.status).toBe(413);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body['type'])).toMatch(/(too-large|file_too_large)/);
      // Use-case MUST NOT be invoked — post-parse guard fires before
      // dispatch.
      expect(runImportCsvMock).not.toHaveBeenCalled();
    });
  });

  describe('415 unsupported-media-type', () => {
    it('415 when Content-Type is not multipart/form-data', async () => {
      const { POST } = await loadImportRoute();
      const res = await POST(
        buildRequest({ contentType: 'application/json' }),
      );

      expect(res.status).toBe(415);
      expect(runImportCsvMock).not.toHaveBeenCalled();
    });
  });

  describe('429 rate-limited', () => {
    it('429 with Retry-After header when 5/hr limit exhausted', async () => {
      const resetAt = Date.now() + 1800 * 1000;
      csvImportRateLimitCheckMock.mockResolvedValue({
        success: false,
        resetAtUnixMs: resetAt,
      });

      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());

      expect(res.status).toBe(429);
      const retryAfter = res.headers.get('Retry-After');
      expect(retryAfter).toBeTruthy();
      const seconds = Number(retryAfter);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(1800);
      // Use-case MUST NOT be invoked when rate-limit denied
      expect(runImportCsvMock).not.toHaveBeenCalled();
    });
  });

  describe('504 csv-timeout', () => {
    it('504 when use-case reports time-budget exceeded', async () => {
      runImportCsvMock.mockResolvedValue({ kind: 'timeout' });

      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());

      expect(res.status).toBe(504);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body['type'])).toMatch(/(csv-timeout|timeout)/);
    });
  });

  describe('500 — unexpected use-case error', () => {
    it('500 when use-case returns unexpected_error', async () => {
      runImportCsvMock.mockResolvedValue({
        kind: 'unexpected_error',
        message: 'simulated stage failure',
      });

      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());

      expect(res.status).toBe(500);
    });
  });

  describe('FR-035 RBAC matrix (post-Phase-9 E1 closure — manager 403, member 404)', () => {
    // CSV import is a write action on /admin/events/** per spec.md:250.
    // Pre-Phase-9 implementation used the `/admin/integrations/**`
    // 404-for-all guard (drift from spec). Closed in the verify-pass
    // remediation by switching to `adminOnlyWriterGuard`: manager gets
    // 403 (action-level deny — they see the events surface but can't
    // mutate), member gets 404 (surface-disclosure).

    it('403 — manager attempts CSV import → 403 + role_violation_blocked audit (action-level deny per spec.md:250)', async () => {
      getCurrentSessionMock.mockResolvedValue(MANAGER_SESSION);

      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());

      // Spec.md FR-035 + plan.md:72.
      expect(res.status).toBe(403);
      const body = (await res.json()) as { title?: string };
      expect(body.title).toBe('Forbidden');
      // Manager 403 path emits role_violation_blocked with actorRole=manager.
      expect(emitStandaloneMock).toHaveBeenCalled();
      const emittedEntry = emitStandaloneMock.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(emittedEntry?.['eventType']).toBe('role_violation_blocked');
      expect(emittedEntry?.['actorType']).toBe('manager');
      expect(runImportCsvMock).not.toHaveBeenCalled();
    });

    it('404 — member attempts CSV import → 404 (surface disclosure)', async () => {
      getCurrentSessionMock.mockResolvedValue(MEMBER_SESSION);

      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());

      expect(res.status).toBe(404);
      // 404 path emits role_violation_blocked too with actorRole=member.
      expect(emitStandaloneMock).toHaveBeenCalled();
      const emittedEntry = emitStandaloneMock.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(emittedEntry?.['actorType']).toBe('member');
      expect(runImportCsvMock).not.toHaveBeenCalled();
    });

    it('404 — no session → 404 (surface disclosure; admin-only route)', async () => {
      getCurrentSessionMock.mockResolvedValue(null);

      const { POST } = await loadImportRoute();
      const res = await POST(buildRequest());

      expect(res.status).toBe(404);
      expect(runImportCsvMock).not.toHaveBeenCalled();
    });
  });

  describe('FR-035 kill-switch — 404 when FEATURE_F6_EVENTCREATE is false', () => {
    it('returns 404 when feature flag is off', async () => {
      vi.resetModules();
      vi.doMock('@/lib/env', async () => {
        const actual = await vi.importActual<typeof import('@/lib/env')>(
          '@/lib/env',
        );
        return {
          ...actual,
          env: {
            ...actual.env,
            features: {
              ...actual.env.features,
              f6EventCreate: false,
            },
            tenant: { slug: 'test-swecham' },
          },
        };
      });

      const mod = (await import('@/app/api/admin/events/import/route')) as {
        POST: (req: NextRequest) => Promise<Response>;
      };
      const res = await mod.POST(buildRequest());

      expect(res.status).toBe(404);
      expect(runImportCsvMock).not.toHaveBeenCalled();

      vi.doUnmock('@/lib/env');
      vi.resetModules();
    });
  });

  describe('Audit emit on success (FR-029 / FR-035)', () => {
    it('does NOT call standalone audit-emit on the happy 200 path — the use-case emits csv_import_completed inside the tx', async () => {
      runImportCsvMock.mockResolvedValue({
        kind: 'completed',
        summary: {
          rowsProcessed: 1,
          rowsAlreadyImported: 0,
          eventsCreated: 1,
          eventsUpdated: 0,
          matchCounts: {
            member_contact: 0,
            member_domain: 0,
            member_fuzzy: 0,
            non_member: 1,
            unmatched: 0,
          },
          errorRows: [],
          durationMs: 200,
        },
      });

      const { POST } = await loadImportRoute();
      await POST(buildRequest());

      // The csv_import_completed audit is emitted INSIDE the use-case
      // (tx-scoped). The route's `makeStandaloneAuditDeps` is ONLY used
      // for RBAC-rejection paths (role_violation_blocked), not happy
      // path. So emitStandalone MUST stay un-called here.
      expect(emitStandaloneMock).not.toHaveBeenCalled();
    });
  });
});

/**
 * T087 (108 US5) — `buildAudienceTick`: build the Resend audience with ONE
 * Contacts-Import call, confirm it on a later tick, then send.
 *
 * A separate use case from `dispatchScheduledBroadcast` on purpose. That one is
 * ~1,200 lines carrying the orphan-audience reuse dance, the idempotency-conflict
 * replay, the FR-021 retry budget and the batch hand-off; threading an
 * `if (importEnabled)` through it would give every one of those paths two shapes
 * and make its 44-case suite the regression surface for both. The route picks
 * one or the other; neither learns the other exists.
 *
 * **The dangerous cases come first in this file, deliberately.** The happy path
 * is the easy one to write and the one least likely to be wrong. What can send
 * a broadcast to the wrong set of people is the completion rule, and each of
 * its four clauses is its own case here, because each has to fail for a
 * DIFFERENT reason in the audit row.
 *
 * The clause that is not defensive: `status === 'completed'` does not mean the
 * rows landed. One import in five identical probes returned `completed` with
 * `failed: 0` and `total: 0` and attached nothing (research R9 V2 (c)). Without
 * the `total === resolvedCount` clause that is a send to an empty audience,
 * reported as success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';

const tenant = asTenantContext('test-tenant');
const BROADCAST_ID = asBroadcastId('44444444-4444-4444-8444-444444444444');
const NOW = new Date('2026-09-08T12:00:00Z');
const RECIPIENTS = ['a@example.com', 'b@example.com', 'c@example.com'];

interface Recorder {
  readonly createdAudiences: string[];
  readonly importsSubmitted: Array<{ audienceId: string; emails: readonly string[] }>;
  readonly broadcastsCreated: string[];
  readonly sends: string[];
  readonly attachedImports: string[];
  readonly completions: number[];
  readonly transitions: Array<{ status: string }>;
  readonly audits: string[];
}

function makeDeps(opts: {
  /** Row already carries an import id → this tick is a POLL, not a submit. */
  readonly audienceImportId?: string | null;
  readonly audienceImportSubmittedAt?: Date | null;
  readonly resendAudienceId?: string | null;
  readonly importStatus?: string;
  readonly counts?: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  readonly resolveFails?: 'too_large' | 'empty';
}): { deps: unknown; rec: Recorder } {
  const rec: Recorder = {
    createdAudiences: [],
    importsSubmitted: [],
    broadcastsCreated: [],
    sends: [],
    attachedImports: [],
    completions: [],
    transitions: [],
    audits: [],
  };

  const broadcast = {
    broadcastId: BROADCAST_ID,
    tenantId: tenant.slug,
    status: 'approved' as const,
    subject: 'Hello',
    bodyHtml: '<p>hi</p>',
    fromName: 'SweCham',
    replyToEmail: 'reply@example.com',
    requestedByMemberId: 'm-1',
    segmentType: 'all_members' as const,
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: RECIPIENTS.length,
    resendAudienceId: opts.resendAudienceId ?? null,
    audienceImportId: opts.audienceImportId ?? null,
    audienceImportSubmittedAt: opts.audienceImportSubmittedAt ?? null,
    audienceImportCompletedAt: null,
  };

  return {
    rec,
    deps: {
      tenant,
      clock: { now: () => NOW },
      fromEmail: 'noreply@example.com',
      tenantDisplayName: 'Test Chamber',
      locale: 'en' as const,
      /**
       * Injected rather than composed here: the resolver's own dependency
       * graph (members bridge, unsubscribes, attendees, plans) is large, and
       * this use case only needs the ANSWER. Keeps the file readable and the
       * composition at the route where it already lives.
       */
      resolveRecipients: async () =>
        opts.resolveFails === 'too_large'
          ? err({ kind: 'broadcast_audience_too_large' as const, count: 99_999, cap: 5_000 })
          : opts.resolveFails === 'empty'
            ? err({ kind: 'broadcast_audience_post_suppression_empty' as const })
            : ok({
                recipients: RECIPIENTS,
                estimatedCount: RECIPIENTS.length,
                orphans: [],
                droppedByPreference: 0,
              }),
      broadcastsRepo: {
        async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
          return fn(null);
        },
        async lockForUpdate() {
          return 'approved';
        },
        async findByIdInTx() {
          return broadcast;
        },
        async attachAudienceId(_tx: unknown, _t: unknown, _b: unknown, id: string) {
          rec.createdAudiences.push(id);
        },
        async attachAudienceImport(_tx: unknown, _t: unknown, _b: unknown, id: string) {
          rec.attachedImports.push(id);
        },
        async markAudienceImportCompleted() {
          rec.completions.push(1);
        },
        async attachResendIds() {
          /* no-op */
        },
        async applyTransition(_tx: unknown, _t: unknown, _b: unknown, status: string) {
          rec.transitions.push({ status });
          return { ...broadcast, status };
        },
      },
      broadcastsGateway: {
        async createAudience(name: string) {
          rec.createdAudiences.push(name);
          return { audienceId: 'aud-new' };
        },
        async createContactImport(audienceId: string, emails: readonly string[]) {
          rec.importsSubmitted.push({ audienceId, emails });
          return { importId: 'imp-new' };
        },
        async getContactImport() {
          return {
            status: opts.importStatus ?? 'completed',
            counts:
              opts.counts ??
              { total: RECIPIENTS.length, created: RECIPIENTS.length, updated: 0, skipped: 0, failed: 0 },
          };
        },
        async createBroadcast(args: { audienceId: string }) {
          rec.broadcastsCreated.push(args.audienceId);
          return { broadcastId: 'rb-1' };
        },
        async sendBroadcast(id: string) {
          rec.sends.push(id);
        },
      },
      audit: {
        async emit(_tx: unknown, e: { eventType: string }) {
          rec.audits.push(e.eventType);
        },
      },
    },
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('buildAudienceTick — the completion rule (T087)', () => {
  it('completed with total 0 → does NOT send', async () => {
    // The one measured in the wild. `status: completed`, `failed: 0`, and
    // nothing attached. Reading only `status` sends this broadcast to an empty
    // Resend audience and reports success.
    const { deps, rec } = makeDeps({
      audienceImportId: 'imp-1',
      audienceImportSubmittedAt: NOW,
      importStatus: 'completed',
      counts: { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
    });

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatchObject({
      kind: 'audience_import_failed',
      reason: 'count_mismatch',
    });
    expect(rec.sends).toEqual([]);
    expect(rec.broadcastsCreated).toEqual([]);
    expect(rec.completions).toEqual([]);
  });

  it('failed > 0 → does NOT send, and says WHICH clause refused', async () => {
    const { deps, rec } = makeDeps({
      audienceImportId: 'imp-1',
      audienceImportSubmittedAt: NOW,
      counts: { total: 3, created: 2, updated: 0, skipped: 0, failed: 1 },
    });

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    // Distinct reasons matter: "some rows were rejected" and "the totals do not
    // add up" need different operator responses, and the audit row is where
    // that distinction survives.
    expect(result.error).toMatchObject({
      kind: 'audience_import_failed',
      reason: 'failed_rows',
    });
    expect(rec.sends).toEqual([]);
  });

  it('parts that do not sum to total → does NOT send', async () => {
    const { deps, rec } = makeDeps({
      audienceImportId: 'imp-1',
      audienceImportSubmittedAt: NOW,
      counts: { total: 3, created: 1, updated: 0, skipped: 0, failed: 0 },
    });

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatchObject({
      kind: 'audience_import_failed',
      reason: 'counts_incoherent',
    });
    expect(rec.sends).toEqual([]);
  });

  it('total that does not equal the count WE resolved → does NOT send', async () => {
    // The audience drifted between the submit tick and this one. Comparing the
    // provider's total against a fresh resolve is what gives FR-044 (a) — "the
    // list is fixed at the first attempt" — without a working table: if it
    // moved, the send is refused rather than delivered to the wrong set.
    const { deps, rec } = makeDeps({
      audienceImportId: 'imp-1',
      audienceImportSubmittedAt: NOW,
      counts: { total: 5, created: 5, updated: 0, skipped: 0, failed: 0 },
    });

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatchObject({
      kind: 'audience_import_failed',
      reason: 'count_mismatch',
    });
    expect(rec.sends).toEqual([]);
  });
});

describe('buildAudienceTick — waiting, and not submitting twice (T087)', () => {
  it('still pending → no send, no write, and NO second import', async () => {
    const { deps, rec } = makeDeps({
      audienceImportId: 'imp-1',
      audienceImportSubmittedAt: new Date(NOW.getTime() - 60_000),
      importStatus: 'pending',
    });

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: 'import_pending' });
    expect(rec.sends).toEqual([]);
    expect(rec.completions).toEqual([]);
    // The idempotency guard. A second import would create a second job for the
    // same audience and make the counts un-checkable.
    expect(rec.importsSubmitted).toEqual([]);
  });

  it('pending past 30 minutes → stuck, and terminal rather than polled forever', async () => {
    const { deps, rec } = makeDeps({
      audienceImportId: 'imp-1',
      audienceImportSubmittedAt: new Date(NOW.getTime() - 31 * 60_000),
      importStatus: 'pending',
    });

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatchObject({ kind: 'audience_import_stuck' });
    expect(rec.sends).toEqual([]);
  });

  it('exactly 30 minutes is NOT yet stuck — the boundary is strictly greater', async () => {
    const { deps } = makeDeps({
      audienceImportId: 'imp-1',
      audienceImportSubmittedAt: new Date(NOW.getTime() - 30 * 60_000),
      importStatus: 'pending',
    });

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: 'import_pending' });
  });
});

describe('buildAudienceTick — the two happy ticks (T087)', () => {
  it('tick 1: resolves, creates the audience, submits ONE import, and does not send', async () => {
    const { deps, rec } = makeDeps({});

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: 'import_submitted', importId: 'imp-new' });

    expect(rec.importsSubmitted).toHaveLength(1);
    expect(rec.importsSubmitted[0]!.emails).toEqual(RECIPIENTS);
    expect(rec.attachedImports).toEqual(['imp-new']);
    // Nothing is delivered yet — Resend has only ACCEPTED the job.
    expect(rec.sends).toEqual([]);
    expect(rec.transitions).toEqual([]);
  });

  it('tick 1 REUSES an audience left by a previous attempt instead of orphaning another', async () => {
    // Same rule dispatchScheduledBroadcast follows: a retry after a downstream
    // failure must not leak a second audience — on Resend Free, three is the
    // whole allowance.
    const { deps, rec } = makeDeps({ resendAudienceId: 'aud-existing' });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(rec.importsSubmitted[0]!.audienceId).toBe('aud-existing');
    expect(rec.createdAudiences).not.toContain('aud-new');
  });

  it('tick 2: every clause passes → stamps completion, creates the broadcast, sends', async () => {
    const { deps, rec } = makeDeps({
      audienceImportId: 'imp-1',
      audienceImportSubmittedAt: new Date(NOW.getTime() - 60_000),
      resendAudienceId: 'aud-existing',
    });

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: 'sent' });

    // Order matters: the completion stamp is what makes the send legitimate,
    // so it must be written, not implied.
    expect(rec.completions).toEqual([1]);
    expect(rec.broadcastsCreated).toEqual(['aud-existing']);
    expect(rec.sends).toEqual(['rb-1']);
    expect(rec.transitions.map((t) => t.status)).toEqual(['sending']);
    // And no second import was submitted on the confirming tick.
    expect(rec.importsSubmitted).toEqual([]);
  });
});

describe('buildAudienceTick — resolver refusals keep their existing meaning (T087)', () => {
  it.each<['too_large' | 'empty', string]>([
    ['too_large', 'broadcast_audience_too_large'],
    ['empty', 'broadcast_audience_post_suppression_empty'],
  ])('a %s resolve is refused with the SAME error the single-tick path uses', async (mode, kind) => {
    // Deliberately not a fifth import-specific outcome: these two mean the same
    // thing whichever way the audience is pushed, and inventing new kinds would
    // fork the cron's switch and its alerting for no gain.
    const { deps, rec } = makeDeps({ resolveFails: mode });

    const result = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect((result.error as { kind: string }).kind).toBe(kind);
    expect(rec.importsSubmitted).toEqual([]);
  });
});

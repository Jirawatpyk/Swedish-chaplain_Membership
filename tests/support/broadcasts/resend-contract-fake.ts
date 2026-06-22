// tests/support/broadcasts/resend-contract-fake.ts
//
// Contract-faithful fake of the Resend Broadcasts SDK client. Unlike the
// lenient port-level mocks, this enforces the limits Resend actually returned
// during the 2026-06-21 go-live verification, so a gateway test that builds an
// over-long name or a double-wrapped `from` FAILS here exactly as it would in
// production. Limits are pinned to observed Resend errors; see the design spec.
const MAX_NAME_CP = 70;

type ResendResult<T> = { data: T | null; error: { statusCode: number; message: string; name: string } | null };

export interface ResendBroadcastsClientLike {
  readonly broadcasts: {
    create(args: { audienceId: string; from: string; subject: string; html: string; replyTo: string; name: string }): Promise<ResendResult<{ id: string }>>;
    send(id: string, opts?: unknown): Promise<ResendResult<{ id: string }>>;
    get(id: string): Promise<ResendResult<{ id: string }>>;
  };
  readonly audiences: {
    create(args: { name: string }): Promise<ResendResult<{ id: string }>>;
    remove(id: string): Promise<ResendResult<{ deleted: boolean; id: string; object: string }>>;
    list(): Promise<ResendResult<{ object: 'list'; data: Array<{ id: string; name: string; created_at: string }> }>>;
  };
  readonly contacts: {
    create(args: unknown): Promise<ResendResult<{ id: string }>>;
    remove(args: unknown): Promise<ResendResult<{ deleted: boolean }>>;
    list(args: unknown): Promise<ResendResult<{ data: unknown[] }>>;
  };
}

export function createResendContractFake(opts: {
  audienceLimit?: number;
  /**
   * When `true`, `contacts.remove({ audienceId, email })` returns a 404
   * (`resource_missing`) for an audienceId that was NEVER created OR has
   * already been deleted via `audiences.remove`. This models real Resend
   * behaviour after an ephemeral audience is cleaned up (PR-2): the contact
   * can no longer be removed because its audience is gone, and the gateway's
   * `removeContactFromAudience` 404-tolerance path must treat that as "already
   * erased". Default `false` preserves the original always-success behaviour
   * for the existing gateway/contract consumers (PR-1) — only the
   * erasure-after-cleanup integration test opts in.
   */
  contactsRemove404OnDeletedAudience?: boolean;
} = {}): {
  client: ResendBroadcastsClientLike;
  createdAudienceCount: () => number;
  /**
   * The audience ids created via `audiences.create`, in creation order.
   * Unlike `createdAudienceIds` (which is mutated on remove), this list is
   * append-only so the cross-member isolation test can assert the COUNT and
   * IDENTITY of audiences created across a dispatch run even if some were
   * later deleted.
   */
  createdAudienceIdsInOrder: () => readonly string[];
  /**
   * The set of contact emails (lower-cased) recorded against `audienceId` via
   * `contacts.create`. Returns an empty set for an unknown audience. The
   * cross-member isolation test reads this to assert each broadcast's audience
   * holds EXACTLY its own recipients (no cross-member PII leak).
   */
  getAudienceContacts: (audienceId: string) => ReadonlySet<string>;
} {
  const audienceLimit = opts.audienceLimit ?? Number.POSITIVE_INFINITY;
  const remove404OnDeletedAudience =
    opts.contactsRemove404OnDeletedAudience ?? false;
  let audienceCount = 0;
  const createdAudienceIds = new Set<string>();
  // Append-only creation log (never mutated on remove) — distinct from the
  // `createdAudienceIds` liveness set above.
  const createdAudienceIdsInOrder: string[] = [];
  // audienceId → set of lower-cased contact emails added to it.
  const audienceContacts = new Map<string, Set<string>>();
  // audienceId → display name (populated on create; NOT removed on remove so
  // createdAudienceIdsInOrder can still resolve names for diagnostics).
  const audienceNames = new Map<string, string>();
  // Fixed ISO string used for all fake audiences — tests must not depend on
  // wall-clock time; a real cron only needs the string to be parseable.
  const FAKE_CREATED_AT = '2026-01-01T00:00:00.000Z';
  const client: ResendBroadcastsClientLike = {
    broadcasts: {
      async create(args) {
        if ([...args.name].length > MAX_NAME_CP) {
          return { data: null, error: { statusCode: 422, message: 'Field `name` has a maximum of 70 items.', name: 'validation_error' } };
        }
        // Reject a nested `<>` (the #3 double-wrap bug). Single-wrapped
        // `Name <local@domain>` → the regex extracts the bare address into
        // `inner` (no `<`/`>`, email validates → accepted). Double-wrapped
        // `Name <X <addr>>` (trailing `>>`) → the regex matches nothing (no
        // `<…>` can satisfy `\s*$`; `[^>]*` cannot span the inner `>`), so the
        // `?? args.from` fallback feeds the whole string to the `includes('<')`
        // guard below, which rejects it.
        const addrMatch = args.from.match(/<([^>]*)>\s*$/);
        const inner = addrMatch?.[1] ?? args.from;
        if (inner.includes('<') || inner.includes('>') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inner.trim())) {
          return { data: null, error: { statusCode: 422, message: `Invalid \`from\` field. Received \`${args.from}\`.`, name: 'validation_error' } };
        }
        // Finding B — also reject angle brackets in the DISPLAY-NAME part
        // (everything before the trailing `<address>`). Real Resend rejects
        // `<Acme> via SweCham <noreply@…>` because the unquoted `<`/`>` in the
        // display name is not valid RFC 5322. The trailing-address regex above
        // happily extracts the valid bare address and would otherwise let this
        // through — masking the gateway's un-sanitised `${fromName}`. The
        // gateway's `stripAngleBrackets(fromName)` fix makes this pass.
        const displayName =
          addrMatch !== null
            ? args.from.slice(0, args.from.length - addrMatch[0].length)
            : '';
        if (displayName.includes('<') || displayName.includes('>')) {
          return { data: null, error: { statusCode: 422, message: `Invalid \`from\` field. Received \`${args.from}\`.`, name: 'validation_error' } };
        }
        return { data: { id: 'bcast_fake_1' }, error: null };
      },
      async send(id) { return { data: { id }, error: null }; },
      async get(_id) { return { data: null, error: { statusCode: 404, message: 'not found', name: 'not_found' } }; },
    },
    audiences: {
      async create(args) {
        if (audienceCount >= audienceLimit) {
          const limitLabel = Number.isFinite(audienceLimit) ? String(audienceLimit) : '3';
          return { data: null, error: { statusCode: 401, message: `Your plan includes ${limitLabel} segments. Upgrade to add more.`, name: 'restricted' } };
        }
        audienceCount += 1;
        const id = `aud_fake_${audienceCount}`;
        createdAudienceIds.add(id);
        createdAudienceIdsInOrder.push(id);
        audienceContacts.set(id, new Set<string>());
        audienceNames.set(id, args.name);
        return { data: { id }, error: null };
      },
      async remove(id: string) {
        // A previously-created audience: succeed and remove from the tracking set
        // (models idempotent real-Resend behaviour: a second remove returns 404).
        if (createdAudienceIds.has(id)) {
          createdAudienceIds.delete(id);
          return { data: { deleted: true, id, object: 'audience' }, error: null };
        }
        // Unknown or already-removed audience → 404 (matches Resend API).
        return { data: null, error: { statusCode: 404, message: 'Audience not found', name: 'not_found' } };
      },
      async list() {
        // Return the currently-live audiences (those in `createdAudienceIds`).
        // The SDK shape: { data: { object: 'list', data: [{id, name, created_at}] } }
        const data = [...createdAudienceIds].map((id) => ({
          id,
          name: audienceNames.get(id) ?? '',
          created_at: FAKE_CREATED_AT,
        }));
        return { data: { object: 'list' as const, data }, error: null };
      },
    },
    contacts: {
      async create(args: unknown) {
        // Record (audienceId → lower-cased email) so a test can assert which
        // contacts landed in which audience. The gateway's
        // `addContactsToAudience` calls `sdk.contacts.create({ audienceId,
        // email, ... })`, one contact per call.
        const a = (args ?? {}) as { audienceId?: unknown; email?: unknown };
        if (typeof a.audienceId === 'string' && typeof a.email === 'string') {
          const set = audienceContacts.get(a.audienceId) ?? new Set<string>();
          set.add(a.email.toLowerCase());
          audienceContacts.set(a.audienceId, set);
        }
        return { data: { id: `contact_fake_${randomId()}` }, error: null };
      },
      async remove(args: unknown) {
        const a = (args ?? {}) as { audienceId?: unknown; email?: unknown };
        // Opt-in only: model a deleted/never-created audience as a 404 so the
        // erasure-after-cleanup test exercises the gateway's
        // `removeContactFromAudience` `resource_missing` 404-tolerance path.
        if (
          remove404OnDeletedAudience &&
          typeof a.audienceId === 'string' &&
          !createdAudienceIds.has(a.audienceId)
        ) {
          return {
            data: null,
            error: { statusCode: 404, message: 'Audience not found', name: 'not_found' },
          };
        }
        // Default (back-compat): succeed. Also drop the email from the recorded
        // set when both fields are present, so a test can observe removal.
        if (typeof a.audienceId === 'string' && typeof a.email === 'string') {
          audienceContacts.get(a.audienceId)?.delete(a.email.toLowerCase());
        }
        return { data: { deleted: true }, error: null };
      },
      async list() { return { data: { data: [] }, error: null }; },
    },
  };
  return {
    client,
    createdAudienceCount: () => audienceCount,
    createdAudienceIdsInOrder: () => [...createdAudienceIdsInOrder],
    getAudienceContacts: (audienceId: string) =>
      new Set(audienceContacts.get(audienceId) ?? new Set<string>()),
  };
}

/** Short random suffix for fake contact ids — avoids id collisions when many
 *  contacts are created in one test (purely cosmetic; ids are unused). */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

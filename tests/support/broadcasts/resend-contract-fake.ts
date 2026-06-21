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
  };
  readonly audiences: {
    create(args: { name: string }): Promise<ResendResult<{ id: string }>>;
  };
  readonly contacts: {
    create(args: unknown): Promise<ResendResult<{ id: string }>>;
    remove(args: unknown): Promise<ResendResult<{ deleted: boolean }>>;
    list(args: unknown): Promise<ResendResult<{ data: unknown[] }>>;
  };
}

export function createResendContractFake(opts: { audienceLimit?: number } = {}): {
  client: ResendBroadcastsClientLike;
  createdAudienceCount: () => number;
} {
  const audienceLimit = opts.audienceLimit ?? Number.POSITIVE_INFINITY;
  let audienceCount = 0;
  const client: ResendBroadcastsClientLike = {
    broadcasts: {
      async create(args) {
        if ([...args.name].length > MAX_NAME_CP) {
          return { data: null, error: { statusCode: 422, message: 'Field `name` has a maximum of 70 items.', name: 'validation_error' } };
        }
        // Valid `from`: `local@domain` or `Name <local@domain>` — no nested `<`.
        const inner = args.from.match(/<([^>]*)>\s*$/)?.[1] ?? args.from;
        if (inner.includes('<') || inner.includes('>') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inner.trim())) {
          return { data: null, error: { statusCode: 422, message: `Invalid \`from\` field. Received \`${args.from}\`.`, name: 'validation_error' } };
        }
        return { data: { id: 'bcast_fake_1' }, error: null };
      },
      async send(id) { return { data: { id }, error: null }; },
    },
    audiences: {
      async create() {
        if (audienceCount >= audienceLimit) {
          return { data: null, error: { statusCode: 401, message: `Your plan includes ${audienceLimit} segments. Upgrade to add more.`, name: 'restricted' } };
        }
        audienceCount += 1;
        return { data: { id: `aud_fake_${audienceCount}` }, error: null };
      },
    },
    contacts: {
      async create() { return { data: { id: 'contact_fake_1' }, error: null }; },
      async remove() { return { data: { deleted: true }, error: null }; },
      async list() { return { data: { data: [] }, error: null }; },
    },
  };
  return { client, createdAudienceCount: () => audienceCount };
}

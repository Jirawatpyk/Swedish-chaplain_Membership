/**
 * 108 T007 — the single shared `RecipientLocalePort` test double.
 *
 * Before 108 every invoicing test declared its own `{ getMemberEmailLocale:
 * vi.fn(...) }` literal. Widening the port with `getMemberEmailRecipient`
 * (the LIVE money-email address) would have meant editing ~30 literals for
 * every future port change, and — worse — a literal that forgets the new
 * method typechecks nowhere near the failure: the use case just calls
 * `undefined` at runtime. One factory, one place to extend.
 *
 * `email` defaults to the value a file's `MemberIdentitySnapshot` fixture
 * carries, so pass the SAME address the fixture uses when behaviour must not
 * change; pass `null` to model "this member has no live primary contact"
 * (the FR-003 skip path).
 */
import { vi, type MockedFunction } from 'vitest';
import type { RecipientLocalePort } from '@/modules/invoicing/application/ports/recipient-locale-port';
import type { F4OutboxLocale } from '@/modules/invoicing/application/ports/email-outbox-port';

/** Used when a test does not care which address the live read returns. */
export const DEFAULT_LIVE_PRIMARY_EMAIL = 'live-primary@example.com';

export interface RecipientLocaleFakeOptions {
  /** The live primary contact's address; `null` = no live primary contact. */
  readonly email?: string | null;
  /** Stored preference; `null` = none (the outbox applies its own 'en'). */
  readonly locale?: F4OutboxLocale | null;
}

export interface RecipientLocaleFake extends RecipientLocalePort {
  getMemberEmailLocale: MockedFunction<RecipientLocalePort['getMemberEmailLocale']>;
  getMemberEmailRecipient: MockedFunction<RecipientLocalePort['getMemberEmailRecipient']>;
}

export function makeRecipientLocaleFake(
  options: RecipientLocaleFakeOptions = {},
): RecipientLocaleFake {
  const email = options.email === undefined ? DEFAULT_LIVE_PRIMARY_EMAIL : options.email;
  const locale = options.locale ?? null;
  return {
    getMemberEmailLocale: vi.fn(async (_tx: unknown, _tenantId: string, _memberId: string) => locale),
    getMemberEmailRecipient: vi.fn(async (_tx: unknown, _tenantId: string, _memberId: string) =>
      email === null ? null : { email, locale },
    ),
  };
}

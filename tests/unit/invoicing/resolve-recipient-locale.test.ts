/**
 * Email-locale audit 2026-07-16 — unit coverage for the F4 recipient-locale
 * resolver. Proves the precedence contract the enqueue sites depend on:
 * a member preference is honoured; a null member (non-member event buyer) and
 * an unset preference both fall through to `undefined` (outbox → 'en').
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveRecipientLocale } from '@/modules/invoicing/application/lib/resolve-recipient-locale';
import type { RecipientLocalePort } from '@/modules/invoicing/application/ports/recipient-locale-port';

function makePort(returns: 'en' | 'th' | 'sv' | null): RecipientLocalePort {
  return { getMemberEmailLocale: vi.fn(async () => returns) };
}

describe('resolveRecipientLocale', () => {
  it('returns the stored member preference when present', async () => {
    const port = makePort('th');
    const result = await resolveRecipientLocale(port, {}, 'test-swecham', 'member-1');
    expect(result).toBe('th');
    expect(port.getMemberEmailLocale).toHaveBeenCalledWith({}, 'test-swecham', 'member-1');
  });

  it('returns undefined (not en) when the member has no stored preference', async () => {
    const port = makePort(null);
    const result = await resolveRecipientLocale(port, {}, 'test-swecham', 'member-1');
    expect(result).toBeUndefined();
  });

  it('skips the lookup entirely for a null member (non-member event buyer)', async () => {
    const port = makePort('th');
    const result = await resolveRecipientLocale(port, {}, 'test-swecham', null);
    expect(result).toBeUndefined();
    expect(port.getMemberEmailLocale).not.toHaveBeenCalled();
  });
});

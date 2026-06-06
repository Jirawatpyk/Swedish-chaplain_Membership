/**
 * 055-member-number — an EVENT (non-member) draft snapshots member_number=null.
 * The buyer object has no member_number field; makeMemberIdentitySnapshot's
 * .default(null) supplies it. Pins that create-event-invoice-draft needs NO new
 * param (a future buyer.member_number add would wrongly leak a number onto the
 * §105 receipt path).
 *
 * Regression-lock (not a red→green cycle): with PDF-1 merged this is GREEN
 * immediately, which is the intended confirmation that the event path is
 * unchanged. The strip-of-the-key path is exercised here end-to-end through the
 * real use-case + real makeMemberIdentitySnapshot (only the I/O deps mocked).
 */
import { describe, expect, it, vi } from 'vitest';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';

describe('055 — event draft snapshot has member_number=null', () => {
  it('persists a null member_number for a non-member buyer', async () => {
    const insertDraft = vi.fn(async (_tx: unknown, _args: { memberIdentitySnapshot: unknown }) => {
      return { invoiceId: 'inv', status: 'draft' } as never;
    });
    const deps = {
      invoiceRepo: {
        withTx: (fn: (tx: unknown) => unknown) => fn({}),
        insertDraft,
      },
      eventRegistrationLookup: {
        findById: vi.fn(async () => ({
          ok: true,
          value: {
            matchedMemberId: null,
            pseudonymised: false,
            ticketPriceThb: 1000,
            eventId: 'evt-1',
          },
        })),
      },
      eventDetailsLookup: {
        findById: vi.fn(async () => ({
          ok: true,
          value: { name: 'Gala', startDateIso: '2026-09-10T03:00:00.000Z' },
        })),
      },
      memberIdentity: { getForIssue: vi.fn() },
      audit: { emit: vi.fn() },
      newUuid: () => '00000000-0000-0000-0000-0000000000a1',
    } as never;

    await createEventInvoiceDraft(deps, {
      tenantId: 't1',
      actorUserId: 'u1',
      eventRegistrationId: '00000000-0000-0000-0000-0000000000e9',
      buyer: {
        legal_name: 'Walk-in Guest',
        tax_id: null,
        address: '50 Sukhumvit, Bangkok',
        primary_contact_name: 'Jane',
        primary_contact_email: '',
      },
    } as never);

    expect(insertDraft).toHaveBeenCalledTimes(1);
    const snap = (
      insertDraft.mock.calls[0]![1] as {
        memberIdentitySnapshot: { member_number: number | null };
      }
    ).memberIdentitySnapshot;
    expect(snap.member_number).toBeNull();
  });
});

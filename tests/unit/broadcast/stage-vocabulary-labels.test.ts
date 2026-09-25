/**
 * F119 T120 (FR-019, plan Amendment 1) — the stage vocabulary on the two
 * status namespaces every E-Blast screen reads.
 *
 * `approved` is the stage FR-019 calls **Scheduled**: after the approval round
 * exists it is reached by marketing confirming the send time, so "Approved"
 * would name the member's act on a row the member no longer holds.
 *
 * The second test is the one that bites later: it enumerates the Domain
 * status tuple, so the moment 0308's five statuses join it (T051) every
 * locale must carry a label for each — next-intl does not throw on a missing
 * key, it renders the raw key path, so without this a new stage would reach
 * the queue chip, the portal list and the staff header as
 * `admin.broadcasts.queue.status.in_design`.
 */
import { describe, it, expect } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';
import { BROADCAST_STATUSES } from '@/modules/broadcasts/domain/value-objects/broadcast-status';

const LOCALES = { en, th, sv } as const;

type StatusLabels = Record<string, string>;

function statusNamespaces(messages: typeof en): Record<string, StatusLabels> {
  return {
    'admin.broadcasts.queue.status': messages.admin.broadcasts.queue.status as StatusLabels,
    'portal.broadcasts.list.status': messages.portal.broadcasts.list.status as StatusLabels,
  };
}

describe('E-Blast stage vocabulary (T120)', () => {
  it('`approved` reads "Scheduled" in both status namespaces', () => {
    for (const labels of Object.values(statusNamespaces(en))) {
      expect(labels.approved).toBe('Scheduled');
    }
  });

  it('`approved` no longer reads "Approved" in TH or SV', () => {
    const previous = { th: 'อนุมัติแล้ว', sv: 'Godkänd' } as const;
    for (const [locale, old] of Object.entries(previous)) {
      const messages = LOCALES[locale as keyof typeof previous] as typeof en;
      for (const labels of Object.values(statusNamespaces(messages))) {
        expect(labels.approved).not.toBe(old);
      }
    }
  });

  it('every status in the Domain tuple has a non-empty label in every locale and namespace', () => {
    const missing: string[] = [];
    for (const [locale, messages] of Object.entries(LOCALES)) {
      for (const [ns, labels] of Object.entries(statusNamespaces(messages as typeof en))) {
        for (const status of BROADCAST_STATUSES) {
          const label = labels[status];
          if (typeof label !== 'string' || label.trim() === '') {
            missing.push(`${locale}:${ns}.${status}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

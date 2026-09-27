/**
 * GDPR Art. 15(4) / 20(4) · PDPA §30 — whose contact data a member archive
 * carries. The owner (by linked user for a self-export, by contact id for a
 * staff export for one named contact) is kept in full, even when removed;
 * current colleagues appear by name and role only; former colleagues not at all.
 */
import { describe, expect, it } from 'vitest';
import {
  projectContactsForRequester,
  type ScopableContact,
} from '@/modules/insights/application/gdpr-contact-scope';

const contact = (over: Partial<ScopableContact>): ScopableContact => ({
  contactId: 'c-x',
  linkedUserId: null,
  firstName: 'X',
  lastName: 'Y',
  email: 'x@acme.example',
  phone: '+66800000000',
  dateOfBirth: null,
  roleTitle: 'Staff',
  preferredLanguage: 'en',
  isPrimary: false,
  removedAt: null,
  createdAt: null,
  ...over,
});

const roster = [
  contact({ contactId: 'c-som', linkedUserId: 'u-som', firstName: 'Som', email: 'som@acme.example' }),
  contact({ contactId: 'c-nils', firstName: 'Nils', email: 'nils@acme.example' }),
  contact({ contactId: 'c-gone', firstName: 'Gone', email: 'gone@acme.example', removedAt: '2026-03-01T00:00:00.000Z' }),
];

describe('projectContactsForRequester', () => {
  it('by linked user: the requester in full, colleagues by name and role, former colleagues dropped', () => {
    const out = projectContactsForRequester(roster, { userId: 'u-som' });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ contactId: 'c-som', email: 'som@acme.example' });
    expect(out[1]).toEqual({ firstName: 'Nils', lastName: 'Y', roleTitle: 'Staff', isPrimary: false });
  });

  it('by contact id: a contact without an account is the owner', () => {
    const out = projectContactsForRequester(roster, { contactId: 'c-nils' });
    expect(out.find((c) => c.contactId === 'c-nils')).toMatchObject({ email: 'nils@acme.example' });
    expect(JSON.stringify(out)).not.toContain('som@acme.example');
  });

  it('by contact id: a former contact keeps their own record', () => {
    const out = projectContactsForRequester(roster, { contactId: 'c-gone' });
    expect(out.find((c) => c.contactId === 'c-gone')).toMatchObject({ email: 'gone@acme.example' });
  });

  it('no owner (company archive): everyone by name and role', () => {
    const out = projectContactsForRequester(roster, {});
    expect(out.every((c) => !('email' in c))).toBe(true);
    expect(out).toHaveLength(2);
  });
});

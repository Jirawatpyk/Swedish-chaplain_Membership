/**
 * F114 — the portal change-request form's starting values (pure; shared by
 * the edit page and its tests).
 *
 *   - `changeRequestInitialValues`: the live Group B record → form strings
 *     (nulls → '');
 *   - `overlayPending` (US5 AS5): a pending request's proposed values are the
 *     starting point — every proposed field substitutes;
 *   - `overlayResubmit` (US3 AS3 / FR-023): a DECIDED request's REJECTED
 *     proposed values substitute, approved fields keep the live (now applied)
 *     value — "prefilled with exactly the rejected values".
 */
import type { ChangeRequestFieldView, ChangeRequestView } from './change-request-portal-view';
import type { ChangeRequestFormValues } from '@/components/members/change-requests/portal-change-request-form';
import type { Contact, Member } from '@/modules/members';

export type { ChangeRequestFormValues };

/** The Group B record → form strings (nulls → ''). */
export function changeRequestInitialValues(member: Member, contact: Contact): ChangeRequestFormValues {
  return {
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone: contact.phone ?? '',
    roleTitle: contact.roleTitle ?? '',
    companyName: member.companyName,
    website: member.website ?? '',
    description: member.description ?? '',
    regLine1: member.addressLine1 ?? '',
    regLine2: member.addressLine2 ?? '',
    regSubDistrict: member.subDistrict ?? '',
    regCity: member.city ?? '',
    regProvince: member.province ?? '',
    regPostalCode: member.postalCode ?? '',
    billLine1: member.billingAddressLine1 ?? '',
    billLine2: member.billingAddressLine2 ?? '',
    billSubDistrict: member.billingSubDistrict ?? '',
    billCity: member.billingCity ?? '',
    billProvince: member.billingProvince ?? '',
    billPostalCode: member.billingPostalCode ?? '',
    billCountry: member.billingCountry ?? '',
  };
}

/** Substitute the given fields' PROPOSED values into the form values. */
export function overlayFields(values: ChangeRequestFormValues, fields: readonly ChangeRequestFieldView[]): ChangeRequestFormValues {
  const out = { ...values };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  for (const f of fields) {
    const p = f.proposed as Record<string, string | null> | string | null;
    switch (f.key) {
      case 'first_name': out.firstName = str(p); break;
      case 'last_name': out.lastName = str(p); break;
      case 'phone': out.phone = str(p); break;
      case 'role_title': out.roleTitle = str(p); break;
      case 'company_name': out.companyName = str(p); break;
      case 'website': out.website = str(p); break;
      case 'description': out.description = str(p); break;
      case 'registered_address':
        if (p && typeof p === 'object') {
          out.regLine1 = p.line1 ?? ''; out.regLine2 = p.line2 ?? ''; out.regSubDistrict = p.sub_district ?? '';
          out.regCity = p.city ?? ''; out.regProvince = p.province ?? ''; out.regPostalCode = p.postal_code ?? '';
        }
        break;
      case 'billing_address':
        if (p && typeof p === 'object') {
          out.billLine1 = p.line1 ?? ''; out.billLine2 = p.line2 ?? ''; out.billSubDistrict = p.sub_district ?? '';
          out.billCity = p.city ?? ''; out.billProvince = p.province ?? ''; out.billPostalCode = p.postal_code ?? '';
          out.billCountry = p.country ?? '';
        }
        break;
      default: {
        // a tenth Group B key must fail the build here, not fall through and
        // silently prefill the resubmit form from the LIVE record (round 6)
        const _exhaustive: never = f.key;
        void _exhaustive;
      }
    }
  }
  return out;
}

/** US5 AS5 — a pending request's proposed values are the starting point. */
export function overlayPending(values: ChangeRequestFormValues, pending: ChangeRequestView | null): ChangeRequestFormValues {
  if (!pending) return values;
  return overlayFields(values, pending.fields);
}

/** US3 AS3 — only the REJECTED values of a decided request are prefilled; approved fields start from the live record. */
export function overlayResubmit(values: ChangeRequestFormValues, decided: ChangeRequestView | null): ChangeRequestFormValues {
  if (!decided || decided.state !== 'decided') return values;
  return overlayFields(values, decided.fields.filter((f) => f.outcome === 'rejected'));
}

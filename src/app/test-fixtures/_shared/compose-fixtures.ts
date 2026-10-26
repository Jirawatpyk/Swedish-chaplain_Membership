/**
 * Spec 122 US12d-2 follow-up — sample data for the two compose pages in the
 * no-database preview routes, with the boards' own copy
 * (`Portal-broadcast-new`, `Admin-broadcast-new`), so a parity shot compares
 * the same content. Test routes only (`ALLOW_TEST_ROUTES`).
 */
import type { ComposeTemplateOption } from '@/components/broadcast/compose/template-picker-field';
import type { QuotaSnapshot } from '@/components/broadcast/quota-display';

export const COMPOSE_TEMPLATES: readonly ComposeTemplateOption[] = [
  {
    id: 'tpl-event',
    name: 'Event invitation',
    locale: 'en',
    isSeeded: true,
    subject: 'Nordic Leadership Breakfast — 15 October',
    bodyHtml: '<p>Dear members,</p><p>Join us for the event.</p>',
  },
  {
    id: 'tpl-news',
    name: 'Monthly newsletter',
    locale: 'en',
    isSeeded: true,
    subject: 'SweCham news — October',
    bodyHtml: '<p>Dear members,</p>',
  },
];

export const MEMBER_COMPOSE_SAMPLE = {
  subject: 'Nordic Leadership Breakfast — 15 October',
  bodyHtml:
    '<p>Dear members,</p><p>Join us for the <strong>Nordic Leadership Breakfast</strong> on 15 October at the Anantara Siam. Three Swedish CEOs share how they built their Thai teams.</p><p>Seats are limited — reply to reserve yours.</p>',
  quota: { used: 2, reserved: 1, remaining: 3, cap: 6, quotaYear: 2026, planName: 'Premium Corporate' } satisfies QuotaSnapshot,
} as const;

/** The member picker's search rows (`/api/admin/members/search`, `member-picker.tsx`). */
export const STAFF_COMPOSE_MEMBERS = [
  {
    memberId: '0b9e1d2c-0000-4000-8000-000000000001',
    companyName: 'Bangkok Freight Nordic Co., Ltd.',
    primaryContactName: 'Malin Berg',
    hasPrimaryContactEmail: true,
  },
  {
    memberId: '0b9e1d2c-0000-4000-8000-000000000002',
    companyName: 'Siam Nordic Trading Co., Ltd.',
    primaryContactName: 'Erik Holm',
    hasPrimaryContactEmail: true,
  },
] as const;

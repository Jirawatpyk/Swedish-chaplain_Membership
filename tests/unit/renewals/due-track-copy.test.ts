/**
 * 066 Round-2 §3.2(2) — due-track copy parity + content invariants.
 * Email copy is outside check:i18n scope; this test IS the parity gate
 * (same convention as copy.test.ts / reminder-statutory-copy.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  DUE_TRACK_COPY,
  resolveDueTrackCopy,
  STATUTORY_TERMINATION_WARNING,
} from '@/modules/renewals/infrastructure/email/templates/copy';
import { DUE_TRACK_STEP_IDS } from '@/modules/renewals/domain/due-track';

const LOCALES = ['en', 'th', 'sv'] as const;

describe('DUE_TRACK_COPY', () => {
  it('has every step in every locale with non-empty subject/body/cta', () => {
    for (const locale of LOCALES) {
      for (const stepId of DUE_TRACK_STEP_IDS) {
        const c = DUE_TRACK_COPY[locale][stepId];
        expect(c.subject.length, `${locale}/${stepId} subject`).toBeGreaterThan(0);
        expect(c.body.length, `${locale}/${stepId} body`).toBeGreaterThan(0);
        expect(c.cta.length, `${locale}/${stepId} cta`).toBeGreaterThan(0);
      }
    }
  });

  it('due+30 embeds the bylaw termination warning verbatim in each locale', () => {
    for (const locale of LOCALES) {
      expect(DUE_TRACK_COPY[locale]['due+30.email'].body).toContain(
        STATUTORY_TERMINATION_WARNING[locale],
      );
    }
  });

  it('due+7 carries NO termination warning (gentle rung)', () => {
    for (const locale of LOCALES) {
      expect(DUE_TRACK_COPY[locale]['due+7.email'].body).not.toMatch(
        /bylaws|ข้อบังคับ|stadgar/i,
      );
    }
  });

  it('no body claims the membership already EXPIRED (born-awaiting expiry is ~12mo out)', () => {
    for (const locale of LOCALES) {
      for (const stepId of DUE_TRACK_STEP_IDS) {
        expect(DUE_TRACK_COPY[locale][stepId].body).not.toMatch(
          /expired on|หมดอายุเมื่อ|gick ut den/i,
        );
      }
    }
  });

  it('only known interpolation placeholders are used ({firstName}/{companyName})', () => {
    for (const locale of LOCALES) {
      for (const stepId of DUE_TRACK_STEP_IDS) {
        const c = DUE_TRACK_COPY[locale][stepId];
        for (const field of [c.subject, c.body, c.cta]) {
          const placeholders = field.match(/\{(\w+)\}/g) ?? [];
          for (const p of placeholders) {
            expect(['{firstName}', '{companyName}']).toContain(p);
          }
        }
      }
    }
  });

  it('resolveDueTrackCopy returns the locale entry directly', () => {
    expect(resolveDueTrackCopy('due+7.email', 'th')).toBe(DUE_TRACK_COPY.th['due+7.email']);
    expect(resolveDueTrackCopy('due+30.email', 'sv')).toBe(DUE_TRACK_COPY.sv['due+30.email']);
  });
});

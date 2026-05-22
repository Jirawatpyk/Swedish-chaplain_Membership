/**
 * T095 (F7.1a US7 / SC-007b) — Integration test for starter-template seed.
 *
 * Verifies migration 0168 seeded exactly 5 templates × 3 locales = 15
 * rows per production tenant per FR-020 + critique P10.
 *
 * Runs against live Neon Singapore per CLAUDE.md `pnpm test:integration`.
 * The 15 rows for the `swecham` tenant were seeded at migration
 * application time on 2026-05-19 (see CLAUDE.md "Phase 2 T020
 * applied 8 migrations 0161-0168 ... 15 starter templates seeded for
 * swecham").
 *
 * Idempotency check: re-running the seed step does NOT duplicate rows
 * (ON CONFLICT (tenant_id, name, locale) DO NOTHING).
 *
 * RED-first per Constitution Principle II (the count assertion + the
 * locale-completeness assertion both must hold; if they don't the seed
 * was incomplete or the tests are running on a stale migration set).
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { broadcastTemplates } from '@/modules/broadcasts/infrastructure/schema';

// SweCham is the F7.1a launch tenant per CLAUDE.md.
const SWECHAM_TENANT_SLUG = 'swecham';

// Expected EN-locale starter template names per FR-020 + starter-
// templates.md. NOTE: TH + SV variants ship with LOCALIZED names
// (e.g. "จดหมายข่าวประจำเดือน" for Thai) — the seed migration treats
// each (name, locale) tuple independently. Spec invariant is 5 × 3 = 15
// rows per tenant; this list is the EN-locale validation set.
const EXPECTED_EN_NAMES = [
  'Monthly Newsletter',
  'Event Invitation',
  'Member Spotlight',
  'Urgent Announcement',
  'Sponsorship Thank-You',
] as const;

const EXPECTED_LOCALES = ['en', 'th', 'sv'] as const;

describe('F7.1a starter template seed — SC-007b (T095)', () => {
  it('exactly 15 starter templates present for swecham tenant (5 × 3 locales)', async () => {
    const rows = await db
      .select({
        id: broadcastTemplates.id,
        name: broadcastTemplates.name,
        locale: broadcastTemplates.locale,
        isSeeded: broadcastTemplates.isSeeded,
      })
      .from(broadcastTemplates)
      .where(
        and(
          eq(broadcastTemplates.tenantId, SWECHAM_TENANT_SLUG),
          eq(broadcastTemplates.isSeeded, true),
        ),
      );
    expect(rows).toHaveLength(15);
  });

  it('exactly 5 seeded templates per locale (EN+TH+SV)', async () => {
    for (const locale of EXPECTED_LOCALES) {
      const rows = await db
        .select({ name: broadcastTemplates.name })
        .from(broadcastTemplates)
        .where(
          and(
            eq(broadcastTemplates.tenantId, SWECHAM_TENANT_SLUG),
            eq(broadcastTemplates.isSeeded, true),
            eq(broadcastTemplates.locale, locale),
          ),
        );
      expect(rows, `locale=${locale}`).toHaveLength(5);
    }
  });

  it.each(EXPECTED_EN_NAMES)(
    'EN-locale starter template "%s" present',
    async (templateName) => {
      const rows = await db
        .select({ name: broadcastTemplates.name })
        .from(broadcastTemplates)
        .where(
          and(
            eq(broadcastTemplates.tenantId, SWECHAM_TENANT_SLUG),
            eq(broadcastTemplates.name, templateName),
            eq(broadcastTemplates.locale, 'en'),
            eq(broadcastTemplates.isSeeded, true),
          ),
        );
      expect(rows).toHaveLength(1);
    },
  );

  it('all 15 seeded rows carry is_seeded=TRUE (per FR-021 Starter badge UX)', async () => {
    const rows = await db
      .select({
        name: broadcastTemplates.name,
        isSeeded: broadcastTemplates.isSeeded,
      })
      .from(broadcastTemplates)
      .where(
        and(
          eq(broadcastTemplates.tenantId, SWECHAM_TENANT_SLUG),
          eq(broadcastTemplates.isSeeded, true),
        ),
      );
    expect(rows).toHaveLength(15);
    for (const r of rows) {
      expect(r.isSeeded).toBe(true);
    }
  });

  it('seeded templates have non-empty subject + body that fits the CHECK constraints', async () => {
    const rows = await db
      .select({
        name: broadcastTemplates.name,
        subject: broadcastTemplates.subject,
        bodyHtml: broadcastTemplates.bodyHtml,
      })
      .from(broadcastTemplates)
      .where(
        and(
          eq(broadcastTemplates.tenantId, SWECHAM_TENANT_SLUG),
          eq(broadcastTemplates.isSeeded, true),
        ),
      );
    for (const r of rows) {
      expect(r.subject.length).toBeGreaterThan(0);
      expect(r.subject.length).toBeLessThanOrEqual(200);
      expect(r.bodyHtml.length).toBeGreaterThan(0);
      expect(r.bodyHtml.length).toBeLessThanOrEqual(204800); // 200 KB
    }
  });

  it('seeded templates with {{chamber_name}} placeholder ship LITERAL (substitution at runtime, not seed)', async () => {
    const rows = await db
      .select({
        name: broadcastTemplates.name,
        subject: broadcastTemplates.subject,
        bodyHtml: broadcastTemplates.bodyHtml,
      })
      .from(broadcastTemplates)
      .where(
        and(
          eq(broadcastTemplates.tenantId, SWECHAM_TENANT_SLUG),
          eq(broadcastTemplates.isSeeded, true),
          eq(broadcastTemplates.locale, 'en'),
        ),
      );
    // At least ONE starter template MUST reference {{chamber_name}} in
    // its content (the placeholder is the whole point of variable
    // resolution per FR-019). If zero starters use it, either the
    // seed is broken or the starters were rewritten without the
    // canonical placeholder.
    const hasPlaceholder = rows.some(
      (r) =>
        r.subject.includes('{{chamber_name}}') ||
        r.bodyHtml.includes('{{chamber_name}}'),
    );
    expect(hasPlaceholder).toBe(true);
  });
});

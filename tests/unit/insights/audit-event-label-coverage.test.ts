/**
 * Audit event-label i18n coverage guard (QA 2026-07-09 — "audit log shows
 * English in TH/SV").
 *
 * The audit viewer + activity feed + filter dropdown resolve an event code via
 * `resolveEventLabel`: `admin.dashboard.activity.events` → `audit.eventType` →
 * humanised ENGLISH fallback; the member timeline resolves against
 * `audit.eventType` ONLY (falling back to the stored English summary). The
 * fallbacks fire in EVERY locale, so any `audit_event_type` value missing from
 * `audit.eventType` renders English to TH/SV users somewhere. Nothing gated
 * this before: `check:i18n` verifies cross-locale KEY parity only, and the keys
 * were consistently absent from all three locales, so parity held. On main,
 * 212 of the 311 DB enum values were missing from `audit.eventType` (127 after
 * the first 86-label sweep).
 *
 * Invariants pinned here:
 *  1. `ALL_AUDIT_EVENT_TYPES` equals the REAL DB enum — every value the
 *     migrations ever added (`CREATE TYPE` + `ALTER TYPE … ADD VALUE`). The TS
 *     pgEnum tuple alone is NOT the universe: F6/F7/F8 added ~142 values via
 *     hand-written migrations without syncing the tuple (reviewer-#2 finding),
 *     so a tuple-based guard would silently ignore the busiest event families.
 *  2. Every enum value has a label in `audit.eventType` in EN, TH and SV —
 *     the PRIMARY catalogue every consumer can reach. (`activity.events` is a
 *     viewer-phrasing override only; a label present there alone still leaks
 *     English on the member timeline.)
 *  3. Every TH label contains Thai script — a TH value copy-pasted from EN
 *     passes parity but is exactly the reported bug, so it must fail here.
 *  4. Labels are non-empty everywhere.
 *
 * When this fails after adding an enum value: add the label to
 * `audit.eventType` in en.json + th.json + sv.json, and if the value was added
 * by a new migration, extend `DB_ONLY_AUDIT_EVENT_TYPES` (schema.ts) unless the
 * pgEnum tuple itself was updated.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_AUDIT_EVENT_TYPES } from '@/modules/auth';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';

type LabelMap = Readonly<Record<string, string>>;

const LOCALES = [
  ['en', enMessages],
  ['th', thMessages],
  ['sv', svMessages],
] as const;

function catalogues(messages: (typeof LOCALES)[number][1]): {
  activityEvents: LabelMap;
  eventType: LabelMap;
} {
  return {
    activityEvents: messages.admin.dashboard.activity.events as LabelMap,
    eventType: messages.audit.eventType as LabelMap,
  };
}

/**
 * The DB enum ground truth, re-derived from the migrations directory. Every
 * value `audit_log.event_type` can hold got there via `CREATE TYPE … AS ENUM`
 * or `ALTER TYPE … ADD VALUE` (single-line or inside a guarded DO block —
 * `\s+` spans newlines), so parsing the SQL reproduces the exact live enum
 * without a DB connection.
 */
function dbEnumValuesFromMigrations(): ReadonlySet<string> {
  const dir = join(process.cwd(), 'drizzle', 'migrations');
  const values = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const created = sql.match(
      /CREATE TYPE\s+"?(?:public"?\."?)?audit_event_type"?\s+AS ENUM\s*\(([\s\S]*?)\)/i,
    );
    if (created?.[1]) {
      // `[^']+`, NOT `[a-z0-9_]+`: three F8 values carry a hyphen
      // (`…reactivation_reminder_t-7/-3/-1`) — a word-char class silently
      // drops them from the universe (reviewer-2 round-2 finding).
      for (const m of created[1].matchAll(/'([^']+)'/g)) values.add(m[1]!);
    }
    for (const m of sql.matchAll(
      /ALTER TYPE\s+"?(?:public"?\."?)?audit_event_type"?\s+ADD VALUE(?:\s+IF NOT EXISTS)?\s+'([^']+)'/gi,
    )) {
      values.add(m[1]!);
    }
  }
  return values;
}

describe('audit event-label i18n coverage', () => {
  it('ALL_AUDIT_EVENT_TYPES matches the DB enum derived from migrations', () => {
    const db = dbEnumValuesFromMigrations();
    const exported = new Set(ALL_AUDIT_EVENT_TYPES);
    const missingFromExport = [...db].filter((v) => !exported.has(v)).sort();
    const orphanInExport = [...exported].filter((v) => !db.has(v)).sort();
    expect(
      missingFromExport,
      `${missingFromExport.length} DB enum value(s) missing from ALL_AUDIT_EVENT_TYPES — add them to DB_ONLY_AUDIT_EVENT_TYPES (schema.ts)`,
    ).toEqual([]);
    expect(
      orphanInExport,
      'ALL_AUDIT_EVENT_TYPES carries value(s) no migration ever added — remove them or ship the migration',
    ).toEqual([]);
  });

  it.each(LOCALES.map(([locale]) => [locale] as const))(
    'every audit_event_type enum value has a %s label in audit.eventType',
    (locale) => {
      const messages = LOCALES.find(([l]) => l === locale)![1];
      const { eventType } = catalogues(messages);
      const missing = ALL_AUDIT_EVENT_TYPES.filter(
        (code) => !Object.hasOwn(eventType, code),
      );
      expect(
        missing,
        `${missing.length} audit event type(s) fall back to English in "${locale}" — add them to audit.eventType in all 3 locale files`,
      ).toEqual([]);
    },
  );

  it('every TH label in both catalogues contains Thai script (no English copy-paste)', () => {
    const { activityEvents, eventType } = catalogues(thMessages);
    const thai = /[฀-๿]/;
    const englishOnly = [
      ...Object.entries(activityEvents).map(([k, v]) => ['activity.events', k, v] as const),
      ...Object.entries(eventType).map(([k, v]) => ['audit.eventType', k, v] as const),
    ].filter(([, , value]) => !thai.test(value));
    expect(
      englishOnly.map(([ns, k, v]) => `${ns}.${k} = "${v}"`),
      'TH label values must be translated, not copied from EN',
    ).toEqual([]);
  });

  it('labels are non-empty in every locale', () => {
    for (const [locale, messages] of LOCALES) {
      const { activityEvents, eventType } = catalogues(messages);
      for (const [key, value] of [
        ...Object.entries(activityEvents),
        ...Object.entries(eventType),
      ]) {
        expect(value.trim(), `${locale}: empty label for ${key}`).not.toBe('');
      }
    }
  });
});

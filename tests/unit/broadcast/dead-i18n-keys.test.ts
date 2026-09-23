/**
 * F119 T147 (FR-051, exploration § B) — no key in the E-Blast namespaces is
 * unreferenced.
 *
 * A dead translation key is not free: `pnpm check:i18n` forces it into all
 * three locales, so every one of them is a line a translator is asked to
 * keep true about a screen that no longer says it. The E-Blast namespaces had
 * 25 of them — a delete-draft dialog that was removed, a link dialog that
 * moved into the editor chrome, the toolbar `aria.*` block the T099–T102
 * rebuild replaced, and a stale-draft banner that was never mounted at all.
 *
 * ## How the scan decides "referenced"
 *
 * next-intl splits a key across two string literals: the namespace
 * (`useTranslations('portal.broadcasts.compose')`) and the rest
 * (`t('button.saveDraft')`). So a key counts as referenced when SOME split of
 * its path has both halves present in `src/**` as string literals, or when the
 * remainder is covered by a template-literal prefix (`t(`announcements.${k}`)`)
 * in a file that also names the namespace. Literals are taken from anywhere in
 * the source, not only from inside a `t(...)` call, because keys and
 * namespaces legitimately travel as constants (`compose-form.tsx`'s
 * `estimateNoteKey`, `cancel-broadcast-action.tsx`'s `dialogNamespace`).
 *
 * That makes the scan deliberately LENIENT — it can call a dead key live, it
 * must not call a live key dead. Comments are stripped first, so a key
 * mentioned only in a "was X" note (the `progressAria` case) is not mistaken
 * for a reference.
 *
 * ## Positive control
 *
 * A source-scanning gate that cannot tell "nothing to find" from "not
 * looking" is not a gate. `collectDeadKeys` therefore takes the key set as an
 * argument, and the control below hands it a key no source file can possibly
 * contain and asserts the scan reports it — plus asserts the scan finds a
 * NON-EMPTY literal set, so a broken parse cannot pass as a clean run.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import enMessages from '@/i18n/messages/en.json';

const NAMESPACES = ['portal.broadcasts', 'broadcast', 'admin.broadcasts'] as const;

/**
 * Keys the E-Blast surfaces do NOT reference today and that T147 deliberately
 * KEPT, each with the reason. A key may only sit here with a reason — the
 * default for an unreferenced key is deletion.
 */
const KEPT_UNREFERENCED: Readonly<Record<string, string>> = {
  'admin.broadcasts.review.batchLoadFailedTitle':
    'F7.1a split-batch surface — dormant for SweCham (<10k recipients never split), not removed copy',
  'admin.broadcasts.review.batchLoadFailedHint':
    'F7.1a split-batch surface — dormant for SweCham (<10k recipients never split), not removed copy',
  'admin.broadcasts.templates.rowAction.delete':
    'in-list template delete is a documented backlog item (templates/page.tsx header), not a removed control',
  'admin.broadcasts.templates.rowAction.deleteAria':
    'in-list template delete is a documented backlog item (templates/page.tsx header), not a removed control',
  'portal.broadcasts.banner.acknowledgement.closeLabel':
    'lapsed-member acknowledgement banner — kept pending the F119 PR-2 banner pass rather than deleted blind',
};

function flattenKeys(value: unknown, prefix: string, out: string[]): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenKeys(v, prefix === '' ? k : `${prefix}.${k}`, out);
    }
    return;
  }
  out.push(prefix);
}

function eblastKeys(): string[] {
  const all: string[] = [];
  flattenKeys(enMessages, '', all);
  return all.filter((k) =>
    NAMESPACES.some((ns) => k === ns || k.startsWith(`${ns}.`)),
  );
}

function sourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Block comments and whole-line `//` / `*` comments — never a reference. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const QUOTED = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
const TEMPLATE = /`((?:[^`\\]|\\.)*)`/g;

interface ScanIndex {
  readonly literals: ReadonlySet<string>;
  /** Per file: its own literals + its own `prefix.${` template prefixes. */
  readonly dynamicByFile: ReadonlyArray<{
    readonly literals: ReadonlySet<string>;
    readonly prefixes: ReadonlySet<string>;
  }>;
}

function buildIndex(): ScanIndex {
  const literals = new Set<string>();
  const dynamicByFile: Array<{
    literals: Set<string>;
    prefixes: Set<string>;
  }> = [];

  for (const file of sourceFiles(join(process.cwd(), 'src'), [])) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const fileLiterals = new Set<string>();
    for (const m of src.matchAll(QUOTED)) {
      const s = m[1] ?? m[2] ?? '';
      if (s !== '') {
        fileLiterals.add(s);
        literals.add(s);
      }
    }
    const prefixes = new Set<string>();
    for (const m of src.matchAll(TEMPLATE)) {
      const body = m[1] ?? '';
      const at = body.indexOf('${');
      if (at <= 0) continue;
      const head = body.slice(0, at);
      if (head.endsWith('.')) prefixes.add(head.slice(0, -1));
    }
    if (prefixes.size > 0) dynamicByFile.push({ literals: fileLiterals, prefixes });
  }

  return { literals, dynamicByFile };
}

export function collectDeadKeys(
  keys: readonly string[],
  index: ScanIndex,
): string[] {
  const isReferenced = (key: string): boolean => {
    if (index.literals.has(key)) return true;
    const segs = key.split('.');
    for (let i = 1; i < segs.length; i += 1) {
      const ns = segs.slice(0, i).join('.');
      if (!index.literals.has(ns)) continue;
      const rest = segs.slice(i).join('.');
      if (index.literals.has(rest)) return true;
      for (const file of index.dynamicByFile) {
        if (!file.literals.has(ns)) continue;
        for (const prefix of file.prefixes) {
          if (rest === prefix || rest.startsWith(`${prefix}.`)) return true;
        }
      }
    }
    return false;
  };

  return keys.filter((k) => !isReferenced(k));
}

describe('F119 T147 — dead E-Blast i18n keys (FR-051)', () => {
  const index = buildIndex();

  it('the scan actually parses source (positive control)', () => {
    // A parse that yields nothing would report EVERY key as dead, which reads
    // as a catastrophic failure; a parse that yields nothing while the key set
    // is empty would report NOTHING and read as a clean run. Pin both ends.
    expect(index.literals.size).toBeGreaterThan(1000);
    expect(index.literals.has('portal.broadcasts.compose')).toBe(true);

    const fixture = 'portal.broadcasts.compose.__t147DeadKeyFixture__';
    expect(collectDeadKeys([fixture], index)).toEqual([fixture]);
    // …and a key that IS referenced is not reported, so the scan is not just
    // answering "dead" to everything.
    expect(
      collectDeadKeys(['portal.broadcasts.compose.button.saveDraft'], index),
    ).toEqual([]);
  });

  it('no key in the E-Blast namespaces is unreferenced', () => {
    const dead = collectDeadKeys(eblastKeys(), index).filter(
      (k) => !(k in KEPT_UNREFERENCED),
    );
    expect(dead).toEqual([]);
  });

  it('every KEPT exemption is still unreferenced — a revived key must leave the list', () => {
    const dead = new Set(collectDeadKeys(eblastKeys(), index));
    const revived = Object.keys(KEPT_UNREFERENCED).filter((k) => !dead.has(k));
    expect(revived).toEqual([]);
  });
});

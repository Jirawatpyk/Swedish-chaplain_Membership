/**
 * Self-test for `findOrphanKeys` (scripts/lib/i18n-key-refs.ts) — the advisory
 * `check:i18n --orphans` report.
 *
 * The scan used to pool every file's namespaces and every file's `t('…')`
 * literals into two repo-wide lists, so a namespace from one file plus a key
 * suffix from ANOTHER counted as a reference. That is how #377's misplaced
 * `admin.creditNotes.new.successWithNumberNoNotice` looked used: the credit-note
 * form declared the namespace, the void dialog called the suffix.
 */
import { describe, expect, it } from 'vitest';
import { findOrphanKeys } from '@/../scripts/lib/i18n-key-refs';

describe('findOrphanKeys — must report as orphan', () => {
  it('a namespace from one file does not pair with a t() suffix from another (#377)', () => {
    const creditNoteForm = `
      const t = useTranslations('admin.creditNotes.new');
      t('successWithNumber');
    `;
    const voidDialog = `
      const t = useTranslations('admin.invoices.void');
      t('successWithNumberNoNotice');
    `;
    const enKeys = new Set([
      'admin.creditNotes.new.successWithNumber',
      'admin.creditNotes.new.successWithNumberNoNotice',
      'admin.invoices.void.successWithNumberNoNotice',
    ]);
    expect(findOrphanKeys([creditNoteForm, voidDialog], enKeys)).toEqual([
      'admin.creditNotes.new.successWithNumberNoNotice',
    ]);
  });

  it('a key nothing references', () => {
    const src = `const t = useTranslations('shell.nav'); t('home');`;
    expect(findOrphanKeys([src], new Set(['shell.nav.home', 'shell.nav.gone']))).toEqual([
      'shell.nav.gone',
    ]);
  });
});

describe('findOrphanKeys — must NOT report', () => {
  it('a key used through a differently-named translator (tNav)', () => {
    const src = `
      const tNav = useTranslations('shell.nav');
      tNav('home');
    `;
    expect(findOrphanKeys([src], new Set(['shell.nav.home']))).toEqual([]);
  });

  it('a key named in full anywhere', () => {
    const a = `const t = useTranslations(); t('buttons.save');`;
    expect(findOrphanKeys([a], new Set(['buttons.save']))).toEqual([]);
  });

  it('keys under a parent that the same file calls (dynamic composition)', () => {
    const src = `
      const t = useTranslations('admin.status');
      t('labels');
      const label = t(\`labels.\${status}\`);
    `;
    expect(
      findOrphanKeys([src], new Set(['admin.status.labels.active', 'admin.status.labels.void'])),
    ).toEqual([]);
  });
});

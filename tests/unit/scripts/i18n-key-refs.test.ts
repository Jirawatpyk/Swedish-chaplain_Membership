/**
 * Self-test for scripts/lib/i18n-key-refs.ts — the `check:i18n` code → en.json
 * reference gate.
 *
 * Before this gate, `check:i18n` only proved the three locales agree with EACH
 * OTHER. A `t('key')` whose key was absent from en.json passed, because nothing
 * walked from the call site to the catalogue. #377 shipped exactly that: the void
 * dialog called `t('successWithNumberNoNotice')` under `admin.invoices.void`, the
 * copy lived only under `admin.creditNotes.new`, and next-intl rendered the raw
 * dotted key on a money-path warning toast. The first case below is that shape.
 */
import { describe, expect, it } from 'vitest';
import { findMissingKeyRefs } from '@/../scripts/lib/i18n-key-refs';

const EN_KEYS = new Set([
  'admin.invoices.void.successWithNumber',
  'admin.creditNotes.new.successWithNumberNoNotice',
  'admin.invoices.detail.title',
  'shell.nav.home',
  'shell.nav.invoices',
  'buttons.save',
]);

function missing(source: string): string[] {
  return findMissingKeyRefs(source, EN_KEYS).map((r) => r.key);
}

describe('findMissingKeyRefs — keys that MUST be flagged', () => {
  it('flags a key that exists only under a different namespace (#377)', () => {
    const src = `
      const t = useTranslations('admin.invoices.void');
      toast.success(t('successWithNumber', { number }));
      toast.warning(t('successWithNumberNoNotice', { number }));
    `;
    expect(missing(src)).toEqual(['admin.invoices.void.successWithNumberNoNotice']);
  });

  it('resolves an awaited server getTranslations binding', () => {
    const src = `
      const t = await getTranslations('admin.invoices.detail');
      return <h1>{t('title')}</h1>;
      return <p>{t('subtitle')}</p>;
    `;
    expect(missing(src)).toEqual(['admin.invoices.detail.subtitle']);
  });

  it('resolves the object form getTranslations({ locale, namespace })', () => {
    const src = `
      const t = await getTranslations({
        locale,
        namespace: 'shell.nav',
      });
      t('home');
      t('settings');
    `;
    expect(missing(src)).toEqual(['shell.nav.settings']);
  });

  it('treats a namespace-less translator as root-scoped', () => {
    const src = `
      const t = useTranslations();
      const tr = await getTranslations({ locale });
      t('buttons.save');
      t('buttons.delete');
      tr('shell.nav.gone');
    `;
    expect(missing(src)).toEqual(['buttons.delete', 'shell.nav.gone']);
  });

  it('checks t.rich and t.markup like a plain call', () => {
    const src = `
      const t = useTranslations('shell.nav');
      t.rich('home', { b: (c) => <b>{c}</b> });
      t.rich('missingRich', {});
      t.markup('missingMarkup', {});
    `;
    expect(missing(src)).toEqual(['shell.nav.missingRich', 'shell.nav.missingMarkup']);
  });

  it('flags a call that names a subtree rather than a leaf message', () => {
    // t('nav') on a root translator returns no string — next-intl reports
    // INSUFFICIENT_PATH and renders the dotted key, same user-visible failure.
    const src = `
      const t = useTranslations('shell');
      t('nav');
    `;
    expect(missing(src)).toEqual(['shell.nav']);
  });

  it('resolves each call to the NEAREST preceding binding of that name', () => {
    // Two components in one file, each with its own `t`.
    const src = `
      function A() {
        const t = useTranslations('shell.nav');
        return t('home');
      }
      function B() {
        const t = useTranslations('buttons');
        return t('home');
      }
    `;
    expect(missing(src)).toEqual(['buttons.home']);
  });

  it('tracks differently-named translators independently', () => {
    const src = `
      const t = useTranslations('admin.invoices.detail');
      const tNav = useTranslations('shell.nav');
      t('title');
      tNav('invoices');
      tNav('title');
    `;
    expect(missing(src)).toEqual(['shell.nav.title']);
  });

  it('reports the 1-based line of the call', () => {
    const src = [
      "const t = useTranslations('shell.nav');",
      "t('home');",
      "t('nope');",
    ].join('\n');
    expect(findMissingKeyRefs(src, EN_KEYS)).toEqual([
      { key: 'shell.nav.nope', line: 3 },
    ]);
  });

  it('checks a backtick key with no interpolation', () => {
    const src = "const t = useTranslations('shell.nav');\nt(`nope`);";
    expect(missing(src)).toEqual(['shell.nav.nope']);
  });
});

describe('findMissingKeyRefs — shapes that must NOT be flagged', () => {
  it('passes when every literal key exists', () => {
    const src = `
      const t = useTranslations('admin.invoices.void');
      t('successWithNumber', { number });
    `;
    expect(missing(src)).toEqual([]);
  });

  it('skips dynamic keys it cannot resolve statically', () => {
    const src = `
      const t = useTranslations('shell.nav');
      t(key);
      t(\`status.\${s}\`);
      t('prefix.' + code);
      t(cond ? 'a' : 'b');
    `;
    expect(missing(src)).toEqual([]);
  });

  it('skips calls through a translator bound to a dynamic namespace', () => {
    // The dynamic binding SHADOWS the earlier literal one: the nearest binding
    // is unresolvable, so the call is not checked against the wrong namespace.
    const src = `
      const t = useTranslations('shell.nav');
      const t = useTranslations(cfg.namespace);
      t('anything');
    `;
    expect(missing(src)).toEqual([]);
  });

  it('ignores t.has(...) — a presence probe is allowed to miss', () => {
    const src = `
      const t = useTranslations('shell.nav');
      if (t.has('maybe')) t('home');
    `;
    expect(missing(src)).toEqual([]);
  });

  it('accepts t.raw(...) on a subtree', () => {
    const src = `
      const t = useTranslations('shell');
      const all = t.raw('nav');
    `;
    expect(missing(src)).toEqual([]);
  });

  it('ignores calls in comments', () => {
    const src = `
      const t = useTranslations('shell.nav');
      // t('commentedOut')
      /* t('blockCommented') */
      t('home');
    `;
    expect(missing(src)).toEqual([]);
  });

  it('ignores functions that are not a bound translator', () => {
    const src = `
      const t = useTranslations('shell.nav');
      toast('Saved');
      params.get('tab');
      set('value');
      at('x');
    `;
    expect(missing(src)).toEqual([]);
  });

  it('ignores a call that appears before any binding of that name', () => {
    // e.g. a helper that receives `t` as a parameter, defined above the
    // component that creates it — its namespace is not knowable here.
    const src = `
      function label(t: Translator) { return t('fromParam'); }
      function C() {
        const t = useTranslations('shell.nav');
        return t('home');
      }
    `;
    expect(missing(src)).toEqual([]);
  });
});

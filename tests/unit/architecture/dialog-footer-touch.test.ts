/**
 * Spec 122 follow-up 5 (maintainer, 21 Oct 2026) — dialog footer buttons are
 * 44px on phones, and a stretched AURA button stretches with `fullWidth`.
 *
 * 1. Staff screens run AURA's compact density, so a dialog's footer buttons
 *    were 36px below 640px with a fine pointer (the UX review counted about 38
 *    of 40 footers). Every `<Button>` in an AURA `Dialog`'s `footer` carries
 *    `touchHeight` (44px below 640px or on a coarse pointer, whatever the
 *    density).
 * 2. A stretched button set with the `w-full` class keeps AURA's fixed height
 *    and `nowrap`, so a long label overflows instead of wrapping. `fullWidth`
 *    (`.aura-btn--full`) is the supported way: height auto, the label wraps.
 *    Phone-only stretch has no AURA prop yet: `fullWidth` plus
 *    `FULL_WIDTH_BELOW_SM` (stand-in until AURA #165).
 *
 * Parsed with the TypeScript compiler, not a regex, so nested JSX in a footer
 * is walked; each check has a positive control that must fail.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const SRC = join(ROOT, 'src');
const AURA = /^@jirawatpyk\/aura-react(\/server)?$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'ui' && dir === join(SRC, 'components') ? [] : walk(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** Local names bound to AURA's `Dialog`, `Button` and `buttonClass` in one file. */
function auraNames(sf: ts.SourceFile): { dialog: Set<string>; button: Set<string>; buttonClass: Set<string> } {
  const names = { dialog: new Set<string>(), button: new Set<string>(), buttonClass: new Set<string>() };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!AURA.test(st.moduleSpecifier.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === 'Dialog') names.dialog.add(el.name.text);
      if (imported === 'Button') names.button.add(el.name.text);
      if (imported === 'buttonClass') names.buttonClass.add(el.name.text);
    }
  }
  return names;
}

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function attr(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

/** A const in the same file, so `footer={footer}` is walked too. */
function localInitializer(sf: ts.SourceFile, name: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      found = n.initializer;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function openingElements(root: ts.Node): ts.JsxOpeningLikeElement[] {
  const out: ts.JsxOpeningLikeElement[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

interface FooterScan {
  readonly footers: number;
  readonly missing: string[];
}

export function scanFooters(file: string, source: string): FooterScan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = auraNames(sf);
  if (names.dialog.size === 0) return { footers: 0, missing: [] };
  let footers = 0;
  const missing: string[] = [];
  for (const el of openingElements(sf)) {
    if (!names.dialog.has(tagName(el))) continue;
    const footer = attr(el, 'footer');
    const init = footer?.initializer;
    if (!init || !ts.isJsxExpression(init) || !init.expression) continue;
    const expr = init.expression;
    const root = ts.isIdentifier(expr) ? localInitializer(sf, expr.text) : expr;
    if (!root) continue;
    footers += 1;
    for (const btn of openingElements(root)) {
      if (!names.button.has(tagName(btn))) continue;
      if (!attr(btn, 'touchHeight')) {
        const { line } = sf.getLineAndCharacterOfPosition(btn.getStart());
        missing.push(`${file}:${line + 1}`);
      }
    }
    // A link styled as a button (`buttonClass(...)`) in the footer is a
    // footer button too: it needs `touchHeight: true`.
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.buttonClass.has(n.expression.text)) {
        const opts = n.arguments[0];
        const touch =
          opts !== undefined &&
          ts.isObjectLiteralExpression(opts) &&
          opts.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'touchHeight');
        if (!touch) missing.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(root);
  }
  return { footers, missing };
}

/** `w-full` as a bare class (not `max-sm:w-full`, `sm:w-full`, `min-w-full`). */
const BARE_W_FULL = /(?<![\w:-])w-full(?![\w-])/;

export function scanStretched(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = auraNames(sf);
  const hits: string[] = [];
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node): void => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && names.button.has(tagName(n))) {
      const cls = attr(n, 'className');
      if (cls?.initializer && BARE_W_FULL.test(cls.initializer.getText())) hits.push(at(n));
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.buttonClass.has(n.expression.text)) {
      const opts = n.arguments[0];
      if (opts && ts.isObjectLiteralExpression(opts)) {
        const cls = opts.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'className',
        );
        if (cls && BARE_W_FULL.test(cls.initializer.getText())) hits.push(at(n));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

const files = walk(SRC).map((path) => ({ file: relative(ROOT, path), source: readFileSync(path, 'utf8') }));

describe('dialog footer buttons are 44px on phones (spec 122 follow-up 5)', () => {
  const scans = files.map(({ file, source }) => scanFooters(file, source));

  it('positive control: a footer Button without touchHeight is caught, nested JSX included', () => {
    const fixture = [
      "import { Button, Dialog } from '@jirawatpyk/aura-react';",
      'export const A = () => (',
      '  <Dialog open title="t" footer={<><div><Button variant="secondary">No</Button></div><Button touchHeight>Yes</Button></>} />',
      ');',
    ].join('\r\n');
    expect(scanFooters('fixture.tsx', fixture)).toEqual({ footers: 1, missing: ['fixture.tsx:3'] });
  });

  it('positive control: a link styled with buttonClass in a footer needs touchHeight too', () => {
    const fixture = [
      "import { Dialog, buttonClass } from '@jirawatpyk/aura-react';",
      'export const A = () => (',
      "  <Dialog open title=\"t\" footer={<a className={buttonClass({ variant: 'primary' })}>Go</a>} />",
      ');',
    ].join('\n');
    expect(scanFooters('fixture.tsx', fixture)).toEqual({ footers: 1, missing: ['fixture.tsx:3'] });
  });

  it('positive control: the scan parses the app\'s dialog footers', () => {
    expect(scans.reduce((n, s) => n + s.footers, 0)).toBeGreaterThan(30);
  });

  it('every Button in an AURA Dialog footer carries touchHeight', () => {
    expect(scans.flatMap((s) => s.missing)).toEqual([]);
  });
});

describe('a stretched AURA button uses fullWidth, not the w-full class (spec 122 follow-up 5)', () => {
  it('positive control: Button and buttonClass with a bare w-full are caught, max-sm:w-full is not', () => {
    const fixture = [
      "import { Button, buttonClass } from '@jirawatpyk/aura-react/server';",
      'export const A = () => <Button className="mt-2 w-full">Go</Button>;',
      "export const B = buttonClass({ variant: 'secondary', className: 'w-full' });",
      'export const C = () => <Button className="max-sm:w-full">Go</Button>;',
    ].join('\n');
    expect(scanStretched('fixture.tsx', fixture)).toEqual(['fixture.tsx:2', 'fixture.tsx:3']);
  });

  it('no AURA Button or buttonClass stretches with a bare w-full', () => {
    expect(files.flatMap(({ file, source }) => scanStretched(file, source))).toEqual([]);
  });
});

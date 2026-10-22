/**
 * Spec 122 follow-up 5 (maintainer, 21 Oct 2026), adopted on AURA 5.54
 * (22 Oct 2026) — action buttons are 44px on phones through AURA, and a
 * stretched AURA button stretches with `fullWidth`.
 *
 * 1. Since 5.53 (#165) AURA gives the Buttons in a Dialog or Drawer `footer`
 *    44px and wrapping below 640px whatever the density, and since 5.54
 *    (#166) the same for the Buttons in an ActionBar's `children` and
 *    `start`. The per-button `touchHeight` stand-ins came out (maintainer:
 *    "ถอดออก"; a touch tablet from 640px already gets 44px default buttons
 *    from the coarse-pointer density); this keeps them from creeping back,
 *    and checks every footer Button sits where AURA's rule reaches it.
 *    AURA's rules are viewport-based, so a `size="sm"` button there keeps
 *    `touchHeight` for 44px on a touch tablet (#123; R69, 22 Oct).
 * 2. A stretched button set with a `w-full` class — on the button or from its
 *    container (`[&>*]:w-full`) — keeps AURA's fixed height and `nowrap`, so a
 *    long label overflows instead of wrapping. `fullWidth` (or
 *    `fullWidth="below-sm"` for phones only, 5.53) is the supported way.
 *
 * Parsed with the TypeScript compiler, not a regex, so nested JSX is walked;
 * each check has a positive control that must fail.
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

interface AuraNames {
  readonly footered: Set<string>;
  readonly actionBar: Set<string>;
  readonly button: Set<string>;
  readonly buttonClass: Set<string>;
  readonly any: boolean;
}

/** Local names bound to AURA's footered overlays, `ActionBar`, `Button` and `buttonClass`. */
function auraNames(sf: ts.SourceFile): AuraNames {
  const names = {
    footered: new Set<string>(),
    actionBar: new Set<string>(),
    button: new Set<string>(),
    buttonClass: new Set<string>(),
    any: false,
  };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!AURA.test(st.moduleSpecifier.text)) continue;
    names.any = true;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === 'Dialog' || imported === 'Drawer') names.footered.add(el.name.text);
      if (imported === 'ActionBar') names.actionBar.add(el.name.text);
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

/** The JSX an attribute holds, following a same-file const. */
function attrRoot(sf: ts.SourceFile, el: ts.JsxOpeningLikeElement, name: string): ts.Node | undefined {
  const init = attr(el, name)?.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return undefined;
  const expr = init.expression;
  return ts.isIdentifier(expr) ? localInitializer(sf, expr.text) : expr;
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

function isSmall(value: ts.Expression | ts.JsxAttributeValue | undefined): boolean {
  if (value === undefined) return false;
  if (ts.isStringLiteral(value)) return value.text === 'sm';
  if (ts.isJsxExpression(value) && value.expression) return isSmall(value.expression);
  return false;
}

interface TouchSplit {
  /** `touchHeight` on a default-size button: AURA sizes it already. */
  readonly stale: string[];
  /** A `size="sm"` button without `touchHeight`: AURA's rule is viewport-only, so a touch tablet would show it 32px. */
  readonly smallUnsized: string[];
}

/** Each Button and `buttonClass()` under `root`, split by size: default-size `touchHeight` is stale, `size="sm"` needs it. */
function touchHeights(sf: ts.SourceFile, names: AuraNames, root: ts.Node, file: string): TouchSplit {
  const stale: string[] = [];
  const smallUnsized: string[] = [];
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const sort = (n: ts.Node, touch: boolean, small: boolean): void => {
    if (touch && !small) stale.push(at(n));
    if (small && !touch) smallUnsized.push(at(n));
  };
  for (const btn of openingElements(root)) {
    if (names.button.has(tagName(btn))) {
      sort(btn, attr(btn, 'touchHeight') !== undefined, isSmall(attr(btn, 'size')?.initializer));
    }
  }
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.buttonClass.has(n.expression.text)) {
      const opts = n.arguments[0];
      if (opts !== undefined && ts.isObjectLiteralExpression(opts)) {
        const prop = (key: string) =>
          opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === key);
        sort(n, prop('touchHeight') !== undefined, isSmall(prop('size')?.initializer));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return { stale, smallUnsized };
}

interface TouchScan {
  readonly footers: number;
  readonly actionBars: number;
  readonly stale: string[];
  readonly smallUnsized: string[];
}

/**
 * Buttons in Dialog/Drawer footers and ActionBar children and `start`: `touchHeight` left on a default-size button
 * AURA already sizes, and a `size="sm"` button without it.
 */
export function scanStaleTouch(file: string, source: string): TouchScan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = auraNames(sf);
  let footers = 0;
  let actionBars = 0;
  const stale: string[] = [];
  const smallUnsized: string[] = [];
  const add = (split: TouchSplit): void => {
    stale.push(...split.stale);
    smallUnsized.push(...split.smallUnsized);
  };
  for (const el of openingElements(sf)) {
    const tag = tagName(el);
    if (names.footered.has(tag)) {
      const root = attrRoot(sf, el, 'footer');
      if (!root) continue;
      footers += 1;
      add(touchHeights(sf, names, root, file));
    }
    if (names.actionBar.has(tag)) {
      actionBars += 1;
      const start = attrRoot(sf, el, 'start');
      if (start) add(touchHeights(sf, names, start, file));
      // Children: walk the whole element, not the opening tag's attributes.
      if (ts.isJsxOpeningElement(el)) {
        for (const child of el.parent.children) add(touchHeights(sf, names, child, file));
      }
    }
  }
  return { footers, actionBars, stale, smallUnsized };
}

/** A footer Button AURA does not size: neither a direct child nor the only element in a wrapper. */
export function scanUnsizedFooterButtons(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = auraNames(sf);
  const hits: string[] = [];
  const elementChildren = (el: ts.JsxElement) =>
    el.children.filter((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxExpression(c));
  for (const el of openingElements(sf)) {
    if (!names.footered.has(tagName(el))) continue;
    const root = attrRoot(sf, el, 'footer');
    if (!root) continue;
    for (const btn of openingElements(root)) {
      if (!names.button.has(tagName(btn))) continue;
      // Wrapping elements between the footer and the Button (fragments don't
      // count). A Button passed in an attribute (a `trigger`) is left alone:
      // the component decides where it lands.
      const wrappers: ts.JsxElement[] = [];
      let inAttribute = false;
      for (let n: ts.Node | undefined = btn.parent; n && n !== root; n = n.parent) {
        if (ts.isJsxAttribute(n)) inAttribute = true;
        if (ts.isJsxElement(n) && n.openingElement !== btn) wrappers.push(n);
      }
      if (inAttribute || wrappers.length === 0) continue;
      if (wrappers.length === 1 && elementChildren(wrappers[0]!).length === 1) continue;
      hits.push(`${file}:${sf.getLineAndCharacterOfPosition(btn.getStart()).line + 1}`);
    }
  }
  return hits;
}

/** `w-full` as a bare class (not `max-sm:w-full`, `sm:w-full`, `min-w-full`). */
const BARE_W_FULL = /(?<![\w:-])w-full(?![\w-])/;
/** A container stretching its children: `[&>*]:w-full`, `[&>button]:w-full`, `[&_button]:w-full`, `*:w-full`, any variant prefix. */
const CHILD_W_FULL = /(?<![\w-])(?:\[&>\*\]|\[&>button\]|\[&_button\]|\*):w-full(?![\w-])/;

export function scanStretched(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = auraNames(sf);
  if (!names.any) return [];
  const hits: string[] = [];
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const text = attr(n, 'className')?.initializer?.getText() ?? '';
      if (CHILD_W_FULL.test(text) || (names.button.has(tagName(n)) && BARE_W_FULL.test(text))) hits.push(at(n));
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

describe('AURA sizes footer and action-bar buttons on phones; no touchHeight stand-ins (spec 122, AURA 5.53/5.54)', () => {
  const scans = files.map(({ file, source }) => scanStaleTouch(file, source));

  it('positive control: touchHeight in a Dialog or Drawer footer is caught, nested JSX and buttonClass included', () => {
    const fixture = [
      "import { Button, Dialog, Drawer, buttonClass } from '@jirawatpyk/aura-react';",
      'export const A = () => (',
      '  <Dialog open title="t" footer={<><div><Button touchHeight variant="secondary">No</Button></div><Button>Yes</Button></>} />',
      ');',
      "export const B = () => <Drawer open title=\"t\" footer={<a className={buttonClass({ variant: 'primary', touchHeight: true })}>Go</a>} />;",
    ].join('\r\n');
    expect(scanStaleTouch('fixture.tsx', fixture)).toEqual({
      footers: 2,
      actionBars: 0,
      stale: ['fixture.tsx:3', 'fixture.tsx:5'],
      smallUnsized: [],
    });
  });

  it('positive control: touchHeight on an ActionBar button is caught, in children and in start', () => {
    const fixture = [
      "import { ActionBar, Button } from '@jirawatpyk/aura-react';",
      'export const A = () => (',
      '  <ActionBar start={<Button touchHeight>Cancel</Button>}>',
      '    <Button touchHeight>Save</Button>',
      '    <Button>Next</Button>',
      '  </ActionBar>',
      ');',
    ].join('\n');
    expect(scanStaleTouch('fixture.tsx', fixture)).toEqual({
      footers: 0,
      actionBars: 1,
      stale: ['fixture.tsx:3', 'fixture.tsx:4'],
      smallUnsized: [],
    });
  });

  // AURA's footer and ActionBar rules are viewport-based (below 640px). A default-size button on a touch tablet
  // still gets 44px from the coarse-pointer density; a size="sm" one does not, so it keeps touchHeight (#123).
  it('positive control: a size="sm" button needs touchHeight there, and keeping it is not stale', () => {
    const fixture = [
      "import { ActionBar, Button, Dialog, buttonClass } from '@jirawatpyk/aura-react';",
      'export const A = () => (',
      '  <ActionBar start={<Button size="sm">Clear</Button>}>',
      '    <Button size="sm" touchHeight>Archive</Button>',
      "    <Button size={'sm'}>Export</Button>",
      '  </ActionBar>',
      ');',
      "export const B = () => <Dialog open title=\"t\" footer={<a className={buttonClass({ size: 'sm' })}>Go</a>} />;",
    ].join('\n');
    expect(scanStaleTouch('fixture.tsx', fixture)).toEqual({
      footers: 1,
      actionBars: 1,
      stale: [],
      smallUnsized: ['fixture.tsx:3', 'fixture.tsx:5', 'fixture.tsx:8'],
    });
  });

  it("positive control: the scan parses the app's dialog footers and action bars", () => {
    expect(scans.reduce((n, s) => n + s.footers, 0)).toBeGreaterThan(30);
    expect(scans.reduce((n, s) => n + s.actionBars, 0)).toBeGreaterThan(5);
  });

  it('no default-size Button in a Dialog/Drawer footer or an ActionBar carries touchHeight', () => {
    expect(scans.flatMap((s) => s.stale)).toEqual([]);
  });

  it('every size="sm" Button in a Dialog/Drawer footer or an ActionBar carries touchHeight (44px on a touch tablet, #123)', () => {
    expect(scans.flatMap((s) => s.smallUnsized)).toEqual([]);
  });
});

describe('every footer Button is one AURA sizes (direct, or the only element in a wrapper)', () => {
  // AURA 5.53 sizes `.aura-dialog__foot > .aura-btn` and
  // `.aura-dialog__foot > * > .aura-btn:only-child`; a Button deeper, or beside
  // a sibling in a wrapper, stays at the density height on a phone.
  it('positive control: a Button with a sibling in a wrapper, or two wrappers deep, is caught', () => {
    const fixture = [
      "import { Button, Dialog } from '@jirawatpyk/aura-react';",
      'export const A = () => (',
      '  <Dialog open title="t" footer={<>',
      '    <div><Button>No</Button><span>hint</span></div>',
      '    <span><span><Button>Deep</Button></span></span>',
      '    <span><Button>Only child</Button></span>',
      '    <Button>Direct</Button>',
      '  </>} />',
      ');',
    ].join('\n');
    expect(scanUnsizedFooterButtons('fixture.tsx', fixture)).toEqual(['fixture.tsx:4', 'fixture.tsx:5']);
  });

  it('no footer Button sits where AURA does not size it', () => {
    expect(files.flatMap(({ file, source }) => scanUnsizedFooterButtons(file, source))).toEqual([]);
  });
});

describe('a stretched AURA button uses fullWidth, not a w-full class (spec 122 follow-up 5)', () => {
  it('positive control: a bare w-full on Button/buttonClass and a container stretch class are caught', () => {
    const fixture = [
      "import { Button, buttonClass } from '@jirawatpyk/aura-react/server';",
      'export const A = () => <Button className="mt-2 w-full">Go</Button>;',
      "export const B = buttonClass({ variant: 'secondary', className: 'w-full' });",
      'export const C = () => <Button className="max-sm:w-full">Go</Button>;',
      'export const D = () => <div className="flex max-sm:[&>*]:w-full"><Button>Go</Button></div>;',
      'export const E = () => <div className="max-sm:[&>button]:w-full sm:[&_button]:w-full" />;',
      'export const F = () => <div className="max-sm:[&>*]:flex-1 [&>*]:min-w-full" />;',
    ].join('\n');
    expect(scanStretched('fixture.tsx', fixture)).toEqual(['fixture.tsx:2', 'fixture.tsx:3', 'fixture.tsx:5', 'fixture.tsx:6']);
  });

  it('no AURA Button or buttonClass stretches with a w-full class, on itself or from its container', () => {
    expect(files.flatMap(({ file, source }) => scanStretched(file, source))).toEqual([]);
  });
});

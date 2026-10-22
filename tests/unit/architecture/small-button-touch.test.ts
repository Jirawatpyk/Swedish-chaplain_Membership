/**
 * Spec 122 follow-up 5, PR 6 (maintainer, 22 Oct 2026: "consistent และถูกตามหลัก
 * UI") — a `size="sm"` AURA button the user taps is 44px on a phone, wherever
 * it sits.
 *
 * The coarse-pointer density makes a default-size button 44px on a touch
 * screen, but not a `size="sm"` one: it shows 32px (with a 44px hit area
 * from AURA's `::after`). So every `size="sm"` `Button`, `IconButton` and
 * `buttonClass({ size: 'sm' })` in a page body (not-found pages, empty and
 * error states, banners, card actions, list rows, filter controls) carries
 * `touchHeight`.
 *
 * A `Button` or `buttonClass` in a Dialog/Drawer `footer` or an ActionBar's
 * children or `start` is left to AURA: since 5.55 (#167) AURA makes it 44px
 * below 640px or on a coarse pointer, `size="sm"` included, and
 * `dialog-footer-touch.test.ts` refuses a `touchHeight` there.
 *
 * An `IconButton` is a 32px box whatever its `size` (that prop sizes the
 * icon), so every `IconButton` the user taps carries `touchHeight` too.
 *
 * One place stays compact by design, read from the JSX structure: the help
 * icon beside a heading or a label — an `IconButton` that is a `Popover`
 * `trigger` (ⓘ, ?). It sits at the line's height, and AURA gives it a 44px
 * hit area. A row's ⋯ is not exempt: twelve row menus already carry
 * `touchHeight`, and a table stacks into cards on a phone (UX + mobile a11y
 * review, 22 Oct). A `size` that is not a literal fails, so nothing slips past.
 *
 * Parsed with the TypeScript compiler, with positive controls that must fail.
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
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** Local name → AURA export name, for this file's AURA imports. */
function auraImports(sf: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!AURA.test(st.moduleSpecifier.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) names.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  return names;
}

function isSmall(value: ts.Node | undefined): boolean {
  if (value === undefined) return false;
  if (ts.isStringLiteral(value)) return value.text === 'sm';
  if (ts.isJsxExpression(value) && value.expression) return isSmall(value.expression);
  return false;
}

/** An `IconButton` that is a `Popover`'s `trigger`: the help icon beside a heading or a label. */
function isHelpTrigger(el: ts.JsxOpeningLikeElement, names: Map<string, string>): boolean {
  const holder = ts.isJsxSelfClosingElement(el) ? el : el.parent;
  const expr = holder.parent;
  if (!ts.isJsxExpression(expr) || !ts.isJsxAttribute(expr.parent) || expr.parent.name.getText() !== 'trigger') return false;
  const owner = expr.parent.parent.parent;
  return ts.isJsxOpeningLikeElement(owner) && names.get(owner.tagName.getText()) === 'Popover';
}

/**
 * Inside a Dialog/Drawer `footer` or an ActionBar's children or `start`, where AURA sizes a Button (5.55). Read from the
 * JSX around the node, so a footer built in a separate const is not seen; `dialog-footer-touch` follows those.
 */
function inSizedRegion(node: ts.Node, names: Map<string, string>): boolean {
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isJsxAttribute(p) && ts.isJsxOpeningLikeElement(p.parent.parent)) {
      const owner = names.get(p.parent.parent.tagName.getText());
      const key = p.name.getText();
      if ((owner === 'Dialog' || owner === 'Drawer') && key === 'footer') return true;
      if (owner === 'ActionBar' && key === 'start') return true;
    }
    if (ts.isJsxElement(p) && n !== p.openingElement && names.get(p.openingElement.tagName.getText()) === 'ActionBar') return true;
  }
  return false;
}

/** A `size` the scan cannot read: a variable, a ternary, a call. */
function isOpaque(value: ts.Node | undefined): boolean {
  if (value === undefined) return false;
  if (ts.isStringLiteral(value)) return false;
  if (ts.isJsxExpression(value)) return value.expression ? isOpaque(value.expression) : false;
  return true;
}

/**
 * `size="sm"` Buttons and `buttonClass` outside a footer or bar, and every IconButton, without `touchHeight` (help
 * popover triggers aside).
 */
export function scanSmallButtons(file: string, source: string): { readonly small: number; readonly unsized: string[] } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = auraImports(sf);
  let small = 0;
  const unsized: string[] = [];
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = names.get(n.tagName.getText());
      if (tag === 'Button' || tag === 'IconButton') {
        const attr = (key: string) =>
          n.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === key);
        const size = attr('size')?.initializer;
        if (isOpaque(size)) unsized.push(`${at(n)} (size must be a literal)`);
        if (isSmall(size)) small += 1;
        const sized = attr('touchHeight') !== undefined;
        if (tag === 'IconButton' && !sized && !isHelpTrigger(n, names)) unsized.push(at(n));
        if (tag === 'Button' && isSmall(size) && !sized && !inSizedRegion(n, names)) unsized.push(at(n));
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.get(n.expression.text) === 'buttonClass') {
      const opts = n.arguments[0];
      if (opts !== undefined && ts.isObjectLiteralExpression(opts)) {
        const prop = (key: string) =>
          opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === key);
        const size = prop('size')?.initializer;
        if (isOpaque(size)) unsized.push(`${at(n)} (size must be a literal)`);
        if (isSmall(size)) {
          small += 1;
          if (prop('touchHeight') === undefined && !inSizedRegion(n, names)) unsized.push(at(n));
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { small, unsized };
}

const files = walk(SRC).map((path) => ({
  file: relative(ROOT, path).replace(/\\/g, '/'),
  source: readFileSync(path, 'utf8'),
}));

describe('a size="sm" AURA button outside a footer or bar, and every IconButton, carry touchHeight; only a help popover trigger stays compact (spec 122)', () => {
  it('positive control: body, table and menu buttons and a bare IconButton are caught; a help popover trigger and footer/bar buttons are not', () => {
    const fixture = [
      "import { ActionBar, Button, Dialog, IconButton, DropdownMenu, Popover, buttonClass } from '@jirawatpyk/aura-react';",
      "import { Td } from '@/components/shell/aura-table';",
      'export const A = ({ s }: { s: "sm" | "md" }) => (',
      '  <div>',
      '    <Button size="sm">Retry</Button>',
      "    <a className={buttonClass({ variant: 'secondary', size: 'sm' })}>Back</a>",
      '    <IconButton icon="copy" label="Copy" size="sm" />',
      '    <Button size="sm" touchHeight>Kept</Button>',
      '    <Td><Button size="sm">Open</Button></Td>',
      '    <DropdownMenu label="m" items={[]} trigger={<IconButton icon="ellipsis" label="m" size="sm" />} />',
      '    <Popover title="h" trigger={<IconButton icon="info" label="h" size="sm" />}>x</Popover>',
      '    <Button size={s}>Opaque</Button>',
      '    <IconButton icon="search" label="Search" />',
      '    <ActionBar start={<Button size="sm">Clear</Button>}><div><Button size="sm">Archive</Button></div></ActionBar>',
      "    <Dialog open title=\"t\" footer={<a className={buttonClass({ size: 'sm' })}>Go</a>} />",
      '  </div>',
      ');',
    ].join('\r\n');
    expect(scanSmallButtons('fixture.tsx', fixture)).toEqual({
      small: 10,
      unsized: ['fixture.tsx:5', 'fixture.tsx:6', 'fixture.tsx:7', 'fixture.tsx:9', 'fixture.tsx:10', 'fixture.tsx:12 (size must be a literal)', 'fixture.tsx:13'],
    });
  });

  it("positive control: the scan finds the app's small buttons", () => {
    expect(files.reduce((n, { file, source }) => n + scanSmallButtons(file, source).small, 0)).toBeGreaterThan(40);
  });

  it('every size="sm" AURA button and every IconButton the user taps carries touchHeight', () => {
    expect(files.flatMap(({ file, source }) => scanSmallButtons(file, source).unsized)).toEqual([]);
  });
});

/**
 * Spec 122 follow-up 5, PR 6 (maintainer, 22 Oct 2026: "consistent และถูกตามหลัก
 * UI") — a `size="sm"` AURA button the user taps is 44px on a phone, wherever
 * it sits.
 *
 * AURA sizes the buttons of a Dialog/Drawer footer and an ActionBar below
 * 640px (5.53/5.54), and the coarse-pointer density makes a default-size
 * button 44px on a touch screen. A `size="sm"` button gets neither: it shows
 * 32px (with a 44px hit area from AURA's `::after`). So every `size="sm"`
 * `Button`, `IconButton` and `buttonClass({ size: 'sm' })` carries
 * `touchHeight` — in a page body (not-found pages, empty and error states,
 * banners, card actions, list rows, filter controls) as in a footer or bar.
 *
 * Two places stay compact by design, read from the JSX structure, not a file
 * list:
 * - a table cell (`Td`/`Th`, or a DataTable column's `render`/`cell`): a 44px
 *   button would make every row taller;
 * - an `IconButton` that is a menu or popover `trigger` (a row's ⋯, a help ⓘ
 *   beside a heading): an icon affordance kept at the line's height.
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
/** The app's re-export of AURA's table parts (`Td`, `Th`, …). */
const AURA_TABLE = '@/components/shell/aura-table';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** Local name → AURA export name, for this file's AURA imports (and the app's table re-export). */
function auraImports(sf: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!AURA.test(st.moduleSpecifier.text) && st.moduleSpecifier.text !== AURA_TABLE) continue;
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

/** A table cell, or a DataTable column's `render`/`cell`, holds `node`. */
function inTableCell(node: ts.Node, names: Map<string, string>): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p)) {
      const tag = names.get(p.openingElement.tagName.getText());
      if (tag === 'Td' || tag === 'Th') return true;
    }
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && /^(render|cell)$/.test(p.name.getText())) return true;
  }
  return false;
}

/** The element is the value of a `trigger` attribute (a menu's ⋯, a popover's ⓘ). */
function isTrigger(el: ts.JsxOpeningLikeElement): boolean {
  const holder = ts.isJsxSelfClosingElement(el) ? el : el.parent;
  const expr = holder.parent;
  return ts.isJsxExpression(expr) && ts.isJsxAttribute(expr.parent) && expr.parent.name.getText() === 'trigger';
}

/** `size="sm"` AURA buttons without `touchHeight` outside the compact places. */
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
        if (isSmall(attr('size')?.initializer)) {
          small += 1;
          const compact = inTableCell(n, names) || (tag === 'IconButton' && isTrigger(n));
          if (!compact && attr('touchHeight') === undefined) unsized.push(at(n));
        }
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.get(n.expression.text) === 'buttonClass') {
      const opts = n.arguments[0];
      if (opts !== undefined && ts.isObjectLiteralExpression(opts)) {
        const prop = (key: string) =>
          opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === key);
        if (isSmall(prop('size')?.initializer)) {
          small += 1;
          if (!inTableCell(n, names) && prop('touchHeight') === undefined) unsized.push(at(n));
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

describe('a size="sm" AURA button carries touchHeight outside a table cell or a menu/popover icon trigger (spec 122)', () => {
  it('positive control: body buttons and links are caught; table cells and icon triggers are not', () => {
    const fixture = [
      "import { Button, IconButton, DropdownMenu, Popover, buttonClass } from '@jirawatpyk/aura-react';",
      "import { Td } from '@/components/shell/aura-table';",
      'export const A = () => (',
      '  <div>',
      '    <Button size="sm">Retry</Button>',
      "    <a className={buttonClass({ variant: 'secondary', size: 'sm' })}>Back</a>",
      '    <IconButton icon="copy" label="Copy" size="sm" />',
      '    <Button size="sm" touchHeight>Kept</Button>',
      '    <Td><Button size="sm">Open</Button></Td>',
      '    <DropdownMenu label="m" items={[]} trigger={<IconButton icon="ellipsis" label="m" size="sm" />} />',
      '    <Popover title="h" trigger={<IconButton icon="info" label="h" size="sm" />}>x</Popover>',
      '  </div>',
      ');',
      "export const columns = [{ key: 'a', render: () => <Button size={'sm'}>Row</Button> }];",
    ].join('\r\n');
    expect(scanSmallButtons('fixture.tsx', fixture)).toEqual({
      small: 8,
      unsized: ['fixture.tsx:5', 'fixture.tsx:6', 'fixture.tsx:7'],
    });
  });

  it("positive control: the scan finds the app's small buttons", () => {
    expect(files.reduce((n, { file, source }) => n + scanSmallButtons(file, source).small, 0)).toBeGreaterThan(40);
  });

  it('every size="sm" AURA button the user taps outside a table carries touchHeight', () => {
    expect(files.flatMap(({ file, source }) => scanSmallButtons(file, source).unsized)).toEqual([]);
  });
});

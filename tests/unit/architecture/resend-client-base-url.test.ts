/**
 * Spec 141 — every Resend client in src and scripts pins `baseUrl`.
 *
 * resend@6.35 reads `RESEND_BASE_URL` from the process env when a client is
 * built; a client without an explicit `baseUrl` would send the Bearer key (and,
 * on contact calls, a member's email) wherever that var points.
 * `tests/contract/resend/base-url-pinned.contract.test.ts` proves it for the
 * three clients it names; this scan catches the next one.
 *
 * #709 part 3: the scan reads the syntax tree, not the text, so it follows
 * the `Resend` binding wherever the import put it (a renamed import, a
 * namespace, `require`), refuses a subclass and any other escape of the
 * binding, and refuses an options object whose pin a spread could override.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(path);
  }
  return out;
}

export interface ResendScan {
  /** Every `new <Resend>(…)`, as source text. */
  readonly constructions: string[];
  /** Each construction or other use of the binding that is not pinned. */
  readonly violations: string[];
}

function isResendModule(node: ts.Expression | undefined): boolean {
  return node !== undefined && ts.isStringLiteral(node) && node.text === 'resend';
}

function isRequireResend(node: ts.Node | undefined): node is ts.CallExpression {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    isResendModule(node.arguments[0])
  );
}

/**
 * The options argument is pinned only as an object literal holding
 * `baseUrl: RESEND_API_BASE_URL` and nothing a later key could override it
 * with: no spread, no computed key. A variable, `undefined` or an env read
 * lets 6.35 fall back to RESEND_BASE_URL again.
 */
function isPinnedOptions(arg: ts.Expression | undefined): boolean {
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return false;
  let pinned = false;
  for (const p of arg.properties) {
    if (ts.isSpreadAssignment(p)) return false;
    if (p.name !== undefined && ts.isComputedPropertyName(p.name)) return false;
    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === 'baseUrl'
    ) {
      pinned = ts.isIdentifier(p.initializer) && p.initializer.text === 'RESEND_API_BASE_URL';
    }
  }
  return pinned;
}

export function scanResendClients(source: string, fileName = 'x.ts'): ResendScan {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const direct = new Set<string>(); // local names bound to the Resend class
  const namespaces = new Set<string>(); // local names bound to the module

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && isResendModule(st.moduleSpecifier)) {
      const clause = st.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      if (clause.name) namespaces.add(clause.name.text); // default import
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          if ((el.propertyName ?? el.name).text === 'Resend') direct.add(el.name.text);
        }
      }
    }
  }
  const visitRequire = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && isRequireResend(node.initializer)) {
      if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const prop = el.propertyName ?? el.name;
          if (ts.isIdentifier(prop) && prop.text === 'Resend' && ts.isIdentifier(el.name)) {
            direct.add(el.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visitRequire);
  };
  visitRequire(sf);

  const constructions: string[] = [];
  const violations: string[] = [];
  const text = (n: ts.Node): string => n.getText(sf);

  /** A reference to the Resend class: `R` or `ns.Resend`. */
  const isResendRef = (n: ts.Node): boolean =>
    (ts.isIdentifier(n) && direct.has(n.text)) ||
    (ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      namespaces.has(n.expression.text) &&
      n.name.text === 'Resend');

  /** A reference to the module object itself (`ns` outside `ns.Resend`). */
  const isBareNamespace = (n: ts.Node): boolean =>
    ts.isIdentifier(n) &&
    namespaces.has(n.text) &&
    !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n);

  /** The binding's own declaration sites are not uses. */
  const isDeclarationSite = (n: ts.Node): boolean => {
    const p = n.parent;
    return (
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isBindingElement(p) ||
      (ts.isVariableDeclaration(p) && p.name === n) ||
      (ts.isPropertyAccessExpression(p) && p.name === n)
    );
  };

  /** A type position (`x: Resend`, `typeof ns.Resend`) creates nothing. */
  const inTypePosition = (n: ts.Node): boolean => {
    for (let cur: ts.Node = n; cur.parent; cur = cur.parent) {
      // Before isTypeNode: the compiler counts `extends X` as a type node,
      // but a class `extends` runs X's constructor.
      if (ts.isExpressionWithTypeArguments(cur.parent) && ts.isHeritageClause(cur.parent.parent)) {
        return cur.parent.parent.token === ts.SyntaxKind.ImplementsKeyword;
      }
      if (ts.isTypeNode(cur.parent) || ts.isTypeQueryNode(cur.parent)) return true;
      if (ts.isStatement(cur.parent)) return false;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && isResendRef(node.expression)) {
      constructions.push(text(node));
      if (!isPinnedOptions(node.arguments?.[1])) violations.push(text(node));
      node.arguments?.forEach(visit);
      return;
    }
    if (
      (isResendRef(node) && !(ts.isNewExpression(node.parent) && node.parent.expression === node)) ||
      isBareNamespace(node)
    ) {
      if (!isDeclarationSite(node) && !inTypePosition(node)) {
        // extends, assignment, an argument, a return value: the binding
        // escapes the `new` check, so it is refused wherever it goes.
        const at = ts.isHeritageClause(node.parent.parent) ? node.parent.parent.parent : node.parent;
        violations.push(text(at));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { constructions, violations };
}

const PIN_IMPORT = "import { RESEND_API_BASE_URL } from '@/lib/resend-api-base-url';";

describe('Resend clients pin baseUrl (spec 141, #709)', () => {
  it('the parser finds a construction and tells a pinned one from an unpinned one (positive control)', () => {
    const scan = scanResendClients(
      `import { Resend } from 'resend';\n${PIN_IMPORT}\n/** every \`new Resend(…)\` */\nconst a = new Resend(key, { baseUrl: RESEND_API_BASE_URL });\r\n// new Resend(x)\nconst b = new Resend(key);`,
    );
    expect(scan.constructions).toEqual([
      'new Resend(key, { baseUrl: RESEND_API_BASE_URL })',
      'new Resend(key)',
    ]);
    expect(scan.violations).toEqual(['new Resend(key)']);
  });

  it('only the shared constant counts as pinned (an env-driven baseUrl does not)', () => {
    const pinned = (opts: string) =>
      scanResendClients(`import { Resend } from 'resend';\n${PIN_IMPORT}\nnew Resend(key${opts});`).violations.length === 0;
    expect(pinned(', { baseUrl: RESEND_API_BASE_URL }')).toBe(true);
    expect(pinned(', { baseUrl: process.env.RESEND_BASE_URL })')).toBe(false);
    expect(pinned(', { baseUrl: undefined }')).toBe(false);
    expect(pinned('')).toBe(false);
  });

  it.each([
    ['a renamed import', "import { Resend as R } from 'resend';\nnew R(k);"],
    ['a namespace import', "import * as rs from 'resend';\nnew rs.Resend(k);"],
    ['a require', "const { Resend: R } = require('resend');\nnew R(k);"],
    ['a subclass', "import { Resend } from 'resend';\nclass Mine extends Resend {}"],
    ['a spread after the pin', "import { Resend } from 'resend';\nnew Resend(k, { baseUrl: RESEND_API_BASE_URL, ...opts });"],
    ['an options variable', "import { Resend } from 'resend';\nnew Resend(k, opts);"],
    ['an alias of the class', "import { Resend } from 'resend';\nconst R2 = Resend;\nnew R2(k);"],
    ['the namespace passed on', "import * as rs from 'resend';\nbuild(rs);"],
    // Review round 1 (security M1, M2, L3–L5): loaders and shapes the binding
    // walk can't follow are refused outright, so a client must be built
    // from a static import in the file that pins it.
    ['a dynamic import', "const { Resend } = await import('resend');\nnew Resend(k);"],
    ['a dynamic import then', "import('resend').then((m) => new m.Resend(k));"],
    ['a re-export', "export { Resend } from 'resend';"],
    ['a star re-export', "export * from 'resend';"],
    ['a require member read', "const R = require('resend').Resend;\nnew R(k);"],
    ['an import-equals', "import rs = require('resend');\nnew rs.Resend(k, {});"],
    ['a subpath import', "import { Resend } from 'resend/dist/index.mjs';\nnew Resend(k);"],
    [
      'a local constant with the pin\'s name',
      "import { Resend } from 'resend';\nconst RESEND_API_BASE_URL = process.env.RESEND_BASE_URL;\nnew Resend(k, { baseUrl: RESEND_API_BASE_URL });",
    ],
    [
      'a pin constant not imported from the shared module',
      "import { Resend } from 'resend';\nnew Resend(k, { baseUrl: RESEND_API_BASE_URL });",
    ],
    [
      'a getter overriding the pin',
      `import { Resend } from 'resend';\n${PIN_IMPORT}\nnew Resend(k, { baseUrl: RESEND_API_BASE_URL, get baseUrl() { return process.env.X; } });`,
    ],
    [
      'a method overriding the pin',
      `import { Resend } from 'resend';\n${PIN_IMPORT}\nnew Resend(k, { baseUrl: RESEND_API_BASE_URL, baseUrl() { return 'x'; } });`,
    ],
  ])('#709: %s is refused', (_label, source) => {
    expect(scanResendClients(source).violations).not.toEqual([]);
  });

  it.each([
    ['a type-only import', "import type { Resend } from 'resend';\nlet c: Resend;"],
    ['a type-only specifier', "import { type Resend } from 'resend';\nfunction f(c: Resend) { return c; }"],
    ['a pinned renamed import', `import { Resend as R } from 'resend';\n${PIN_IMPORT}\nnew R(k, { baseUrl: RESEND_API_BASE_URL });`],
    ['a pin imported by a relative path (scripts)', "import { Resend } from 'resend';\nimport { RESEND_API_BASE_URL } from '../src/lib/resend-api-base-url';\nnew Resend(k, { baseUrl: RESEND_API_BASE_URL });"],
    ['a quoted baseUrl key', `import { Resend } from 'resend';\n${PIN_IMPORT}\nnew Resend(k, { 'baseUrl': RESEND_API_BASE_URL });`],
    ['a pinned construction in a lazy getter', `import { Resend } from 'resend';\n${PIN_IMPORT}\nlet c: Resend | null = null;\nfunction get(): Resend { return (c ??= new Resend(k, { baseUrl: RESEND_API_BASE_URL })); }`],
  ])('#709: %s is allowed', (_label, source) => {
    expect(scanResendClients(source).violations).toEqual([]);
  });

  it('every Resend client in src and scripts passes baseUrl: RESEND_API_BASE_URL', () => {
    let constructions = 0;
    const violations: Array<{ file: string; at: string }> = [];
    // scripts/ too: an operator script holds a live key just as src does.
    for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))]) {
      const scan = scanResendClients(readFileSync(file, 'utf8'), file);
      constructions += scan.constructions.length;
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      for (const at of scan.violations) violations.push({ file: rel, at });
    }
    // A scan that finds nothing proves nothing: there are three clients today.
    expect(constructions).toBeGreaterThanOrEqual(3);
    expect(violations).toEqual([]);
  });
});

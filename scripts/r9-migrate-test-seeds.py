"""
R9-T1 — migrate integration-test seed pattern (safe, line-based).

Only processes files that match `tx.insert(tenantFeeConfig)` or
`feeConfigRepo.upsert(`. For each matched file:

  1. Replace each `await tx.insert(tenantFeeConfig).values({ ... });`
     block with an equivalent `tx.insert(tenantInvoiceSettings)` block
     that includes all NOT NULL fields for the new schema.
  2. Replace each `await feeConfigRepo.upsert(<ctx>, { ... });` block
     with the same inline insert.
  3. Update imports — ensure `tenantInvoiceSettings` imported from
     `@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings`,
     and remove `tenantFeeConfig` / `feeConfigRepo` imports if the
     file no longer references them.

Line-based — DOES NOT modify any line outside the matched block.
Idempotent: a re-run is a no-op.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = ROOT / "tests" / "integration"

SCHEMA_FEE_IMPORT = "@/modules/plans/infrastructure/db/schema"
SCHEMA_INVOICE_SETTINGS_IMPORT = (
    "@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings"
)
FEE_CONFIG_REPO_IMPORT = "@/modules/plans/infrastructure/db/fee-config-repo"

def parse_body_kv(body_lines: list[str]) -> dict[str, str]:
    """Extract { key: value } pairs from an object literal body."""
    out: dict[str, str] = {}
    for line in body_lines:
        m = re.match(r"\s*(\w+):\s*(.+?)\s*,?\s*$", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out

def render_invoice_settings_insert(indent: str, fields: dict[str, str], tenant_id_expr: str, closer: str) -> list[str]:
    """Build the replacement block. Preserves the trailing closer (e.g. ');' or ');').

    `closer` is the exact text that terminated the original block (e.g.
    "});", "}),"). We match it so the surrounding call-chain (e.g.
    await runInTenant(...)) stays intact.
    """
    # Normalise vat_rate
    vat = fields.get("vatRate", fields.get("vat_rate", "'0.0700'"))
    vat = vat.strip()
    # If vat is a plain number literal like 0.07, convert to '0.0700' string.
    if re.fullmatch(r"0?\.\d{1,4}|\d+\.\d{1,4}", vat):
        try:
            vat = f"'{float(vat):.4f}'"
        except Exception:
            pass

    reg_fee = fields.get("registrationFeeMinorUnits", fields.get("registration_fee_minor_units", "0"))
    reg_fee = reg_fee.strip().rstrip("n")
    try:
        reg_fee_int = int(reg_fee.replace("_", ""))
        reg_fee_literal = f"{reg_fee_int}n"
    except ValueError:
        reg_fee_literal = reg_fee

    currency = fields.get("currencyCode", fields.get("currency_code", "'THB'")).strip()

    lines = [
        f"{indent}await tx.insert(tenantInvoiceSettings).values({{",
        f"{indent}  tenantId: {tenant_id_expr},",
        f"{indent}  currencyCode: {currency},",
        f"{indent}  vatRate: {vat},",
        f"{indent}  registrationFeeSatang: {reg_fee_literal},",
        f"{indent}  legalNameTh: 'Test TH',",
        f"{indent}  legalNameEn: 'Test EN',",
        f"{indent}  taxId: '0000000000000',",
        f"{indent}  registeredAddressTh: 'Test Address TH',",
        f"{indent}  registeredAddressEn: 'Test Address EN',",
        f"{indent}  invoiceNumberPrefix: 'INV',",
        f"{indent}  creditNoteNumberPrefix: 'CN',",
        f"{indent}{closer}",  # e.g. "});"
    ]
    return lines

def find_matching_close(lines: list[str], start_idx: int, open_indent: str) -> int:
    """Given `lines[start_idx]` contains the opening '{', find the index of the
    line containing the matching closing brace with the same or less indent.

    Heuristic: look for a line that starts with `open_indent + '}'` or
    `open_indent + '})'` or `open_indent + '});'`.
    """
    for i in range(start_idx + 1, len(lines)):
        line = lines[i]
        stripped = line.lstrip()
        leading = line[: len(line) - len(stripped)]
        if len(leading) == len(open_indent) and stripped.startswith("}"):
            return i
    return -1

def migrate_tx_insert(lines: list[str]) -> tuple[list[str], int]:
    """Rewrite `tx.insert(tenantFeeConfig).values({ ... })` blocks."""
    out: list[str] = []
    i = 0
    changed = 0
    pattern = re.compile(
        r"^(?P<indent>\s*)await\s+tx\.insert\(tenantFeeConfig\)\.values\(\{\s*$"
    )
    while i < len(lines):
        m = pattern.match(lines[i])
        if not m:
            out.append(lines[i])
            i += 1
            continue
        indent = m.group("indent")
        close_idx = find_matching_close(lines, i, indent)
        if close_idx < 0:
            out.append(lines[i])
            i += 1
            continue
        # The object body lines are between i+1 and close_idx-1 (exclusive).
        body_lines = lines[i + 1 : close_idx]
        fields = parse_body_kv(body_lines)
        tenant_id = fields.get("tenantId", "tenant.ctx.slug")
        closer = lines[close_idx].lstrip()  # e.g. "});" or "}),"
        replacement = render_invoice_settings_insert(indent, fields, tenant_id, closer)
        out.extend(replacement)
        changed += 1
        i = close_idx + 1
    return out, changed

def migrate_fee_config_repo_upsert(lines: list[str]) -> tuple[list[str], int]:
    """Rewrite `feeConfigRepo.upsert(<ctx>, { ... })` blocks."""
    out: list[str] = []
    i = 0
    changed = 0
    # Single-line opener: `await feeConfigRepo.upsert(<ctx>, {`
    pattern = re.compile(
        r"^(?P<indent>\s*)await\s+feeConfigRepo\.upsert\((?P<ctx>[^,]+),\s*\{\s*$"
    )
    while i < len(lines):
        m = pattern.match(lines[i])
        if not m:
            out.append(lines[i])
            i += 1
            continue
        indent = m.group("indent")
        ctx_expr = m.group("ctx").strip()
        close_idx = find_matching_close(lines, i, indent)
        if close_idx < 0:
            out.append(lines[i])
            i += 1
            continue
        body_lines = lines[i + 1 : close_idx]
        fields = parse_body_kv(body_lines)
        tenant_id = f"{ctx_expr}.slug"
        closer_raw = lines[close_idx].lstrip()
        # feeConfigRepo.upsert wraps the object literal, so the closing
        # looks like `});` with possibly preceding `)`. We want the
        # replacement to end with `});` (standard insert pattern).
        closer = "});"
        replacement = render_invoice_settings_insert(indent, fields, tenant_id, closer)
        out.extend(replacement)
        changed += 1
        i = close_idx + 1
    return out, changed

def adjust_imports(text: str) -> str:
    """Add `tenantInvoiceSettings` import when used; remove dead imports."""
    uses_invoice_settings = "tx.insert(tenantInvoiceSettings)" in text
    uses_fee_config_in_insert = re.search(r"tx\.insert\(tenantFeeConfig\)", text)
    uses_fee_config_repo = "feeConfigRepo." in text

    # Add import if needed.
    if uses_invoice_settings and SCHEMA_INVOICE_SETTINGS_IMPORT not in text:
        # Insert after the first import line that mentions plans schema,
        # or else at the top of the import block.
        import_line = f"import {{ tenantInvoiceSettings }} from '{SCHEMA_INVOICE_SETTINGS_IMPORT}';"
        # Find a plans-schema import line.
        plans_schema_import = re.search(
            r"^(import\s+\{[^}]*\}\s+from\s+'@/modules/plans/infrastructure/db/schema';)$",
            text,
            flags=re.MULTILINE,
        )
        if plans_schema_import:
            text = text.replace(
                plans_schema_import.group(0),
                plans_schema_import.group(0) + "\n" + import_line,
                1,
            )
        else:
            # Fallback: insert before the first `describe(`.
            describe = re.search(r"^describe\(", text, flags=re.MULTILINE)
            if describe:
                text = text[: describe.start()] + import_line + "\n\n" + text[describe.start():]

    # Remove tenantFeeConfig from any import clause if no longer used.
    if not uses_fee_config_in_insert:
        # In `import { A, tenantFeeConfig, B } from '@/modules/plans/...';`,
        # strip just tenantFeeConfig.
        def strip_ident(m: re.Match[str]) -> str:
            inner = m.group(1)
            # Remove `tenantFeeConfig` with surrounding commas/whitespace.
            idents = [x.strip() for x in inner.split(",") if x.strip()]
            idents = [x for x in idents if x != "tenantFeeConfig"]
            if not idents:
                return ""  # drop the whole import statement
            return f"import {{ {', '.join(idents)} }} from '{SCHEMA_FEE_IMPORT}';"

        text = re.sub(
            r"^import\s+\{([^}]*)\}\s+from\s+'" + re.escape(SCHEMA_FEE_IMPORT) + r"';\s*$",
            strip_ident,
            text,
            flags=re.MULTILINE,
        )
        # Clean any empty line left behind by a dropped import.
        text = re.sub(r"(\n){3,}", "\n\n", text)

    # Remove feeConfigRepo import entirely if unused.
    if not uses_fee_config_repo:
        text = re.sub(
            r"^import\s+\{\s*feeConfigRepo\s*\}\s+from\s+'" + re.escape(FEE_CONFIG_REPO_IMPORT) + r"';\s*\n",
            "",
            text,
            flags=re.MULTILINE,
        )

    return text

def migrate_file(path: Path) -> bool:
    original = path.read_text(encoding="utf-8")
    if "tenantFeeConfig" not in original and "feeConfigRepo" not in original:
        return False

    lines = original.split("\n")

    lines, a = migrate_tx_insert(lines)
    lines, b = migrate_fee_config_repo_upsert(lines)

    if a + b == 0 and "feeConfigRepo" not in original:
        return False

    text = "\n".join(lines)
    text = adjust_imports(text)

    if text == original:
        return False
    path.write_text(text, encoding="utf-8")
    return True

def main() -> int:
    files = sorted(TESTS_DIR.rglob("*.test.ts"))
    changed = 0
    for f in files:
        if migrate_file(f):
            print(f"  migrated: {f.relative_to(ROOT)}")
            changed += 1
    print(f"\n{changed} file(s) changed")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

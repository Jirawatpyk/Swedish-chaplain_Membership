"""
F8 Phase 6 round-3 I5 — pure-helper tests for `extract-demo-members.py`.

Round-3 review surfaced that the Python extractor had ZERO test
coverage despite owning the schema-version + workbook-header
assertions (CR2 + TD-S1) that gate the seed pipeline. This file pins
the pure-functional helpers so a future contributor's regression
(e.g. tax-id checksum mis-port, country heuristic regression) fails
fast at `python -m unittest` time instead of on the live swecham
tenant during seed.

Uses stdlib `unittest` to avoid introducing a pytest dependency on a
repo that currently has zero Python tests. Run with:

    python -m unittest tests/python/test_extract_demo_members.py

Out of scope: `main()` (needs the Excel workbook + openpyxl —
covered by the seed-pipeline smoke test) and `assert_schema()` (needs
an openpyxl worksheet mock — exercised end-to-end in CI).
"""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path

# Import `extract-demo-members.py` by file path because the filename
# uses hyphens (not a valid Python module identifier).
REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "extract-demo-members.py"

spec = importlib.util.spec_from_file_location(
    "extract_demo_members", str(SCRIPT_PATH)
)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Failed to load {SCRIPT_PATH}")
extract = importlib.util.module_from_spec(spec)
sys.modules["extract_demo_members"] = extract
# `main()` requires openpyxl + the workbook; we only call pure helpers
# below so we work around the import-time `from openpyxl import ...`
# by chdir'ing to repo root (workbook path is relative).
prev_cwd = os.getcwd()
os.chdir(str(REPO_ROOT))
try:
    spec.loader.exec_module(extract)
finally:
    os.chdir(prev_cwd)


class TestSchemaConstants(unittest.TestCase):
    """Schema version + expected headers must stay aligned with TS side."""

    def test_schema_version_is_pinned_to_one(self):
        self.assertEqual(extract.SCHEMA_VERSION, 1)

    def test_members_headers_match_expected_v11(self):
        # A drift here in either direction must trigger a coordinated
        # bump on the TS side (DEMO_SCHEMA_VERSION).
        self.assertEqual(
            extract.EXPECTED_MEMBERS_HEADERS,
            [
                "member_id", "company_name", "display_name", "type_name", "type_id",
                "annual_fee", "status", "product_services", "source_basis", "join_date",
                "expiry_date", "notes", "created_at", "updated_at", "billing_address",
                "tax_id", "branch", "billing_email",
            ],
        )

    def test_contacts_headers_match_expected_v11(self):
        self.assertEqual(
            extract.EXPECTED_CONTACTS_HEADERS,
            [
                "contact_id", "member_id", "company", "full_name", "title",
                "email", "phone", "is_primary", "role",
            ],
        )


class TestThaiTaxIdChecksum(unittest.TestCase):
    """Mirror of the TS Domain checksum policy. Algorithm divergence
    silently produces ineligible-rejected tax IDs in production."""

    def test_valid_known_checksum_passes(self):
        # Two valid fixtures computed against the Revenue Dept algorithm.
        # Verify by hand: weights [13,12,11,10,9,8,7,6,5,4,3,2] applied
        # to digits 1..12, sum mod 11, subtract from 11, mod 10 → d13.
        self.assertTrue(
            extract.validate_thai_tax_id_checksum("0105563084506")
        )
        self.assertTrue(
            extract.validate_thai_tax_id_checksum("0101100010008")
        )

    def test_wrong_check_digit_fails(self):
        # Flip the last digit — must fail.
        self.assertFalse(
            extract.validate_thai_tax_id_checksum("0105563084500")
        )

    def test_non_thirteen_digits_fails(self):
        self.assertFalse(extract.validate_thai_tax_id_checksum("123"))
        self.assertFalse(
            extract.validate_thai_tax_id_checksum("01055000000170")
        )

    def test_non_digit_fails(self):
        self.assertFalse(
            extract.validate_thai_tax_id_checksum("ABCDEFGHIJKLM")
        )


class TestSanitiseTaxId(unittest.TestCase):
    def test_th_corporate_with_valid_checksum_returns_cleaned(self):
        v, reason = extract.sanitise_tax_id("0105563084506", "TH", "regular")
        self.assertEqual(v, "0105563084506")
        self.assertIsNone(reason)

    def test_th_corporate_strips_whitespace_and_dashes(self):
        v, reason = extract.sanitise_tax_id(
            "0105-563-084506", "TH", "regular"
        )
        self.assertEqual(v, "0105563084506")
        self.assertIsNone(reason)

    def test_th_corporate_with_bad_checksum_returns_drop_reason(self):
        v, reason = extract.sanitise_tax_id("0105563084599", "TH", "regular")
        self.assertIsNone(v)
        self.assertEqual(reason, "bad_checksum")

    def test_th_corporate_not_thirteen_digits_returns_drop_reason(self):
        v, reason = extract.sanitise_tax_id("12345", "TH", "regular")
        self.assertIsNone(v)
        self.assertEqual(reason, "not_13_digits")

    def test_th_individual_skips_checksum(self):
        # Individual tier on TH does NOT enforce the checksum.
        v, reason = extract.sanitise_tax_id("anything-here", "TH", "individual")
        self.assertEqual(v, "anythinghere")
        self.assertIsNone(reason)

    def test_non_th_skips_checksum(self):
        v, reason = extract.sanitise_tax_id("SE-12345", "SE", "regular")
        self.assertEqual(v, "SE12345")
        self.assertIsNone(reason)

    def test_too_long_returns_drop_reason(self):
        v, reason = extract.sanitise_tax_id("X" * 60, "SE", "regular")
        self.assertIsNone(v)
        self.assertEqual(reason, "too_long")

    def test_empty_input_returns_none(self):
        self.assertEqual(
            extract.sanitise_tax_id("", "TH", "regular"), (None, None)
        )
        self.assertEqual(
            extract.sanitise_tax_id(None, "TH", "regular"), (None, None)
        )


class TestDetectCountry(unittest.TestCase):
    def test_thailand_keywords(self):
        self.assertEqual(extract.detect_country("123 Bangkok 10110"), "TH")
        self.assertEqual(
            extract.detect_country("Phuket, Thailand 83000"), "TH"
        )
        self.assertEqual(
            extract.detect_country("4/2 Chiang Mai 50000"), "TH"
        )

    def test_sweden_via_country_word_or_diacritic(self):
        self.assertEqual(extract.detect_country("Box 4, Sweden"), "SE")
        self.assertEqual(extract.detect_country("Sandvägen 4"), "SE")

    def test_swedish_postal_pattern_with_diacritic_city(self):
        self.assertEqual(
            extract.detect_country("Sandvägen 4, 352 45 Växjö"), "SE"
        )

    def test_other_countries(self):
        self.assertEqual(extract.detect_country("Singapore 048619"), "SG")
        self.assertEqual(extract.detect_country("Hong Kong office"), "HK")
        self.assertEqual(extract.detect_country("London, United Kingdom"), "GB")
        self.assertEqual(extract.detect_country("Hanoi, Vietnam"), "VN")

    def test_default_is_thailand(self):
        self.assertEqual(extract.detect_country(None), "TH")
        self.assertEqual(extract.detect_country(""), "TH")
        self.assertEqual(
            extract.detect_country("nondescript address"), "TH"
        )

    def test_thai_signal_wins_over_postcode_lookalike(self):
        # Bangkok zip (5 digits) must NOT be misclassified as SE just
        # because it's a 5-digit postal code.
        self.assertEqual(extract.detect_country("Bangkok 10110"), "TH")


class TestNormalisePhone(unittest.TestCase):
    def test_e164_passthrough(self):
        self.assertEqual(extract.normalise_phone("+66812345678"), "+66812345678")

    def test_thai_leading_zero_promoted_to_e164(self):
        self.assertEqual(extract.normalise_phone("0812345678"), "+66812345678")

    def test_strips_separators(self):
        self.assertEqual(
            extract.normalise_phone("+66 (81) 234-5678"), "+66812345678"
        )

    def test_drops_unknown_format(self):
        self.assertIsNone(extract.normalise_phone("not-a-phone"))
        self.assertIsNone(extract.normalise_phone(""))
        self.assertIsNone(extract.normalise_phone(None))

    def test_naked_digits_get_plus_prefix(self):
        self.assertEqual(extract.normalise_phone("447700900123"), "+447700900123")


class TestSplitFullName(unittest.TestCase):
    def test_two_token_name_splits(self):
        self.assertEqual(extract.split_full_name("Trinh Danh"), ("Trinh", "Danh"))

    def test_multi_token_name_concatenates_last(self):
        self.assertEqual(
            extract.split_full_name("Anna van der Berg"),
            ("Anna", "van der Berg"),
        )

    def test_single_token_name_repeats_to_satisfy_lastname_not_null(self):
        self.assertEqual(
            extract.split_full_name("Madonna"), ("Madonna", "Madonna")
        )

    def test_strips_surrounding_whitespace(self):
        self.assertEqual(
            extract.split_full_name("  Jin Park  "), ("Jin", "Park")
        )


class TestLooksLikeEmail(unittest.TestCase):
    def test_valid_email_passes(self):
        self.assertTrue(extract.looks_like_email("admin@acme.example"))
        self.assertTrue(
            extract.looks_like_email("first.last+tag@sub.acme.example")
        )

    def test_invalid_strings_fail(self):
        self.assertFalse(extract.looks_like_email("not an email"))
        self.assertFalse(extract.looks_like_email("missing@tld"))
        self.assertFalse(extract.looks_like_email(""))
        self.assertFalse(extract.looks_like_email(None))


if __name__ == "__main__":
    unittest.main()

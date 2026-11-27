"""
test_design_system.py  –  Design-System Conformance Tests   (Teammate 1 / Day 6)
==================================================================================
Tests LLM code output against the frontend design system WITHOUT hitting the API.

Checks
------
1.  TailwindClassTest     – every className="..." only uses allowed classes
2.  UIComponentTest       – only allowed JSX component tags are used
3.  ForbiddenSyntaxTest   – no banned globals / APIs
4.  FunctionSignatureTest – function is named GeneratedUI with correct props
5.  NoImportExportTest    – no import / export / require
6.  NoBadJSXAttributeTest – no inline style= or arbitrary Tailwind values
7.  ReturnStatementTest   – exactly one return ( at top level
8.  RequiredElementsTest  – ProgressBar, Back, and Submit/Next always present
9.  FrictionHintTest      – friction field hint shown when frictionField is set
10. OutputLengthTest      – output within sensible character bounds

Run:  python test_design_system.py
      python test_design_system.py --verbose
"""

from __future__ import annotations

import re
import sys
import argparse
import textwrap
from dataclasses import dataclass, field
from typing import List, Optional

from prompts import ALLOWED_TAILWIND_CLASSES, UI_COMPONENTS

# ─────────────────────────────────────────────────────────────────────────────
# Test infrastructure
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class TestResult:
    name:    str
    passed:  bool
    message: str
    details: List[str] = field(default_factory=list)

    def __str__(self) -> str:
        status = "✅ PASS" if self.passed else "❌ FAIL"
        lines  = [f"{status}  {self.name}: {self.message}"]
        for d in self.details:
            lines.append(f"       → {d}")
        return "\n".join(lines)


class DesignSystemTestSuite:
    """Runs all design-system conformance checks on a code string."""

    # Tailwind arbitrary-value pattern  e.g. w-[200px]  text-[14px]
    _ARBITRARY_VALUE_RE = re.compile(r'\b[\w-]+\[.+?\]')

    # className="..." extractor (handles single and double quotes)
    _CLASSNAME_RE = re.compile(r'className=["\']([^"\']*)["\']')

    # JSX component tag  e.g. <Button  <Card  <Input
    _JSX_TAG_RE = re.compile(r'<([A-Z][A-Za-z0-9]*)\b')

    # Forbidden globals
    FORBIDDEN_PATTERNS: List[str] = [
        "import ", "export ", "require(", "module.exports",
        "eval(", "Function(", "fetch(", "XMLHttpRequest", "WebSocket",
        "localStorage", "sessionStorage", "document.", "window.",
        "globalThis", "process.", "dangerouslySetInnerHTML",
        "<script", "<iframe", "__proto__", "constructor[",
        "setTimeout(", "setInterval(",
    ]

    # Forbidden JS syntax
    FORBIDDEN_SYNTAX: List[str] = [
        "?.",   # optional chaining
        "??",   # nullish coalescing
        "=>",   # arrow functions
    ]

    def __init__(self, code: str, friction_field: Optional[str] = None):
        self.code          = code
        self.friction_field = friction_field
        self.results: List[TestResult] = []

    # ── individual tests ──────────────────────────────────────────────────────

    def _test_tailwind_classes(self) -> TestResult:
        """Every className value must only contain allowed Tailwind classes."""
        allowed  = set(ALLOWED_TAILWIND_CLASSES)
        bad_classes: List[str] = []

        for match in self._CLASSNAME_RE.finditer(self.code):
            class_string = match.group(1)
            # Check for arbitrary values first
            arb = self._ARBITRARY_VALUE_RE.findall(class_string)
            bad_classes.extend(arb)
            # Check each space-separated class token
            for cls in class_string.split():
                if cls not in allowed and not self._ARBITRARY_VALUE_RE.match(cls):
                    bad_classes.append(cls)

        passed   = len(bad_classes) == 0
        bad_uniq = list(dict.fromkeys(bad_classes))  # dedupe, preserve order
        return TestResult(
            name    = "TailwindClassTest",
            passed  = passed,
            message = "All Tailwind classes are from the allowed list." if passed
                      else f"{len(bad_uniq)} disallowed class(es) found.",
            details = bad_uniq[:10],  # cap at 10 for readability
        )

    def _test_ui_components(self) -> TestResult:
        """Only allowed JSX components and plain HTML tags may appear."""
        allowed_html = {
            "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
            "ul", "ol", "li", "label", "form", "section", "article",
            "header", "footer", "main", "nav", "aside", "figure",
        }
        allowed_components = set(UI_COMPONENTS)
        bad_tags: List[str] = []

        for match in self._JSX_TAG_RE.finditer(self.code):
            tag = match.group(1)
            if tag not in allowed_components and tag.lower() not in allowed_html:
                bad_tags.append(tag)

        passed   = len(bad_tags) == 0
        bad_uniq = list(dict.fromkeys(bad_tags))
        return TestResult(
            name    = "UIComponentTest",
            passed  = passed,
            message = "Only allowed UI components are used." if passed
                      else f"{len(bad_uniq)} disallowed component(s): {bad_uniq}",
            details = bad_uniq,
        )

    def _test_forbidden_globals(self) -> TestResult:
        """No forbidden globals or APIs appear anywhere in the output."""
        hits = [p for p in self.FORBIDDEN_PATTERNS if p in self.code]
        return TestResult(
            name    = "ForbiddenGlobalsTest",
            passed  = len(hits) == 0,
            message = "No forbidden globals detected." if not hits
                      else f"{len(hits)} forbidden pattern(s) found.",
            details = hits,
        )

    def _test_forbidden_syntax(self) -> TestResult:
        """No banned JS syntax (optional chaining, nullish, arrow functions)."""
        hits = [s for s in self.FORBIDDEN_SYNTAX if s in self.code]
        return TestResult(
            name    = "ForbiddenSyntaxTest",
            passed  = len(hits) == 0,
            message = "No forbidden JS syntax detected." if not hits
                      else f"Banned syntax found: {hits}",
            details = hits,
        )

    def _test_function_signature(self) -> TestResult:
        """Output must define exactly `function GeneratedUI({ schema, values, setValue, onSubmit })`."""
        # Allow any whitespace / quote style
        pattern = re.compile(
            r'function\s+GeneratedUI\s*\(\s*\{\s*schema\s*,\s*values\s*,\s*setValue\s*,\s*onSubmit\s*\}\s*\)',
            re.MULTILINE,
        )
        found = bool(pattern.search(self.code))
        return TestResult(
            name    = "FunctionSignatureTest",
            passed  = found,
            message = "GeneratedUI function with correct props found." if found
                      else "GeneratedUI with correct props NOT found.",
        )

    def _test_no_import_export(self) -> TestResult:
        """No import, export, or require statements."""
        bad = [p for p in ["import ", "export ", "require(", "module.exports"]
               if p in self.code]
        return TestResult(
            name    = "NoImportExportTest",
            passed  = len(bad) == 0,
            message = "No import/export/require statements." if not bad
                      else f"Banned statement(s): {bad}",
            details = bad,
        )

    def _test_no_inline_style(self) -> TestResult:
        """No inline style= attributes."""
        hits = re.findall(r'\bstyle\s*=\s*\{', self.code)
        return TestResult(
            name    = "NoInlineStyleTest",
            passed  = len(hits) == 0,
            message = "No inline style= attributes." if not hits
                      else f"{len(hits)} inline style attribute(s) found.",
        )

    def _test_return_statements(self) -> TestResult:
        """Exactly one `return (` in the output (no duplicate generation)."""
        count = len(re.findall(r'\breturn\s*\(', self.code))
        passed = count == 1
        return TestResult(
            name    = "ReturnStatementTest",
            passed  = passed,
            message = f"Exactly one return statement found." if passed
                      else f"{count} return statements found (expected exactly 1).",
        )

    def _test_required_elements(self) -> TestResult:
        """ProgressBar, Back button, and Next/Submit must always be present."""
        checks = {
            "ProgressBar": "<ProgressBar" in self.code,
            "Back button": bool(re.search(r'>Back<', self.code)),
            "Next or Submit button": bool(
                re.search(r'>Next<', self.code) or re.search(r'>Submit<', self.code)
            ),
        }
        missing = [k for k, v in checks.items() if not v]
        return TestResult(
            name    = "RequiredElementsTest",
            passed  = len(missing) == 0,
            message = "All required UI elements present." if not missing
                      else f"Missing element(s): {missing}",
            details = missing,
        )

    def _test_friction_hint(self) -> TestResult:
        """If frictionField is set, its name should appear in the code (for the hint)."""
        if not self.friction_field:
            return TestResult(
                name    = "FrictionHintTest",
                passed  = True,
                message = "No frictionField set — skipped.",
            )
        present = self.friction_field in self.code
        return TestResult(
            name    = "FrictionHintTest",
            passed  = present,
            message = f"frictionField '{self.friction_field}' referenced in component." if present
                      else f"frictionField '{self.friction_field}' NOT referenced — hint may be missing.",
        )

    def _test_output_length(self) -> TestResult:
        """Output must be between 50 and 8000 characters."""
        n = len(self.code)
        passed = 50 <= n <= 8000
        return TestResult(
            name    = "OutputLengthTest",
            passed  = passed,
            message = f"Output length {n} chars is within bounds [50, 8000]." if passed
                      else f"Output length {n} chars is OUT OF BOUNDS [50, 8000].",
        )

    # ── runner ────────────────────────────────────────────────────────────────

    def run(self) -> List[TestResult]:
        """Run every check and return the results list."""
        self.results = [
            self._test_tailwind_classes(),
            self._test_ui_components(),
            self._test_forbidden_globals(),
            self._test_forbidden_syntax(),
            self._test_function_signature(),
            self._test_no_import_export(),
            self._test_no_inline_style(),
            self._test_return_statements(),
            self._test_required_elements(),
            self._test_friction_hint(),
            self._test_output_length(),
        ]
        return self.results

    def summary(self) -> str:
        passed = sum(1 for r in self.results if r.passed)
        total  = len(self.results)
        lines  = [
            "",
            "━" * 60,
            f"  Design-System Conformance: {passed}/{total} tests passed",
            "━" * 60,
        ]
        for r in self.results:
            lines.append(str(r))
        lines.append("━" * 60)
        if passed == total:
            lines.append("  🎉  All checks passed — output is design-system compliant.")
        else:
            lines.append(f"  ⚠️   {total - passed} check(s) failed — output must be regenerated.")
        lines.append("━" * 60)
        return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# Canonical test fixtures  (sample LLM outputs to validate)
# ─────────────────────────────────────────────────────────────────────────────

FIXTURE_GOOD = """\
function GeneratedUI({ schema, values, setValue, onSubmit }) {
  var fields = schema.fields;
  var firstEmpty = Math.max(0, fields.findIndex(function (f) { return !values[f.name]; }));
  var [currentStep, setCurrentStep] = useState(firstEmpty);
  var currentField = fields[currentStep];
  var isLastStep = currentStep === fields.length - 1;
  var progress = ((currentStep + 1) / fields.length) * 100;

  return (
    <Card className="max-w-md mx-auto p-6 space-y-4 bg-white rounded-xl shadow-md">
      <ProgressBar value={progress} />
      <h2 className="text-xl font-semibold text-gray-900">{currentField.label}</h2>
      <p className="text-sm text-gray-600 leading-relaxed">Take your time.</p>
      {currentField.type === "select" ? (
        <Select
          value={values[currentField.name] || ""}
          options={currentField.options}
          onChange={function (v) { setValue(currentField.name, v); }}
        />
      ) : (
        <Input
          type={currentField.type}
          value={values[currentField.name] || ""}
          onChange={function (v) { setValue(currentField.name, v); }}
        />
      )}
      <div className="flex items-center justify-between gap-2 mt-4">
        <Button disabled={currentStep === 0} onClick={function () { setCurrentStep(currentStep - 1); }}>Back</Button>
        {isLastStep ? (
          <Button onClick={onSubmit}>Submit</Button>
        ) : (
          <Button onClick={function () { setCurrentStep(currentStep + 1); }}>Next</Button>
        )}
      </div>
    </Card>
  );
}"""

FIXTURE_BAD_TAILWIND = FIXTURE_GOOD.replace(
    'className="max-w-md mx-auto p-6 space-y-4 bg-white rounded-xl shadow-md"',
    'className="max-w-lg mx-auto p-8 space-y-6 bg-white rounded-2xl shadow-xl w-[500px]"',
)

FIXTURE_BAD_IMPORT = "import React from 'react';\n" + FIXTURE_GOOD

FIXTURE_BAD_EVAL = FIXTURE_GOOD.replace(
    "Take your time.",
    "Take your time. eval('alert(1)')",
)

FIXTURE_BAD_ARROW = FIXTURE_GOOD.replace(
    "function (v) { setValue(currentField.name, v); }",
    "(v) => setValue(currentField.name, v)",
)

FIXTURE_BAD_COMPONENT = FIXTURE_GOOD.replace(
    "<Card ", "<CustomCard ",
)

FIXTURE_WITH_FRICTION = FIXTURE_GOOD.replace(
    "<p",
    '<p className="text-sm text-red-500">Hint: double-check your income field.</p>\n      <p',
)

FIXTURES: list[tuple[str, str, str, bool]] = [
    # (fixture_code, label, friction_field, expect_all_pass)
    (FIXTURE_GOOD,           "GOOD — full conformant output",        None,      True),
    (FIXTURE_BAD_TAILWIND,   "BAD  — disallowed Tailwind classes",   None,      False),
    (FIXTURE_BAD_IMPORT,     "BAD  — import statement present",      None,      False),
    (FIXTURE_BAD_EVAL,       "BAD  — eval() in output",              None,      False),
    (FIXTURE_BAD_ARROW,      "BAD  — arrow function syntax",         None,      False),
    (FIXTURE_BAD_COMPONENT,  "BAD  — unknown JSX component",         None,      False),
    (FIXTURE_WITH_FRICTION,  "GOOD — friction hint for 'income'",    "income",  True),
]


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main(verbose: bool = False) -> int:
    overall_pass = True
    suite_pass   = 0

    print("\n" + "═" * 60)
    print("  Teammate 1 — Design System Conformance Test Suite")
    print("═" * 60)

    for code, label, friction, expect_all_pass in FIXTURES:
        suite = DesignSystemTestSuite(code, friction_field=friction)
        results = suite.run()

        passed_count = sum(1 for r in results if r.passed)
        total_count  = len(results)
        all_passed   = passed_count == total_count

        # A fixture fails the meta-check if our expectation is wrong
        meta_ok = (all_passed == expect_all_pass)
        if not meta_ok:
            overall_pass = False
        else:
            suite_pass += 1

        icon = "✅" if meta_ok else "❌"
        print(f"\n{icon}  Fixture: {label}")

        if verbose or not meta_ok:
            print(suite.summary())
        else:
            print(f"     {passed_count}/{total_count} checks passed"
                  + (" — as expected." if meta_ok else " — UNEXPECTED RESULT."))

    print("\n" + "═" * 60)
    print(f"  Meta-result: {suite_pass}/{len(FIXTURES)} fixtures behaved as expected.")
    print("═" * 60)

    if overall_pass:
        print("  🎉  All fixtures matched expectations.")
    else:
        print("  ❌  Some fixtures did NOT match expectations — review above.")
    print()

    return 0 if overall_pass else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Design-system conformance tests")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Show full check details for every fixture")
    args = parser.parse_args()
    sys.exit(main(verbose=args.verbose))

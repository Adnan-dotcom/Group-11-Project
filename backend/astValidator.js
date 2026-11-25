/**
 * astValidator.js – AuraGen AST Injector & Safety Validator
 * ──────────────────────────────────────────────────────────
 * Parses AI-generated JSX/JS into an AST using @babel/parser,
 * then traverses every node to block dangerous identifiers,
 * member expressions, and known XSS / RCE patterns.
 *
 * Returns:
 *   { valid: true,  code }                on success
 *   { valid: false, error: string }       on syntax error or policy violation
 */

"use strict";

const parser  = require("@babel/parser");
const traverse = require("@babel/traverse").default;

// ──────────────────────────────────────────────
//  Security Policy – identifiers to block
// ──────────────────────────────────────────────

/**
 * Top-level identifiers whose mere presence is a policy violation.
 * These cover code-execution, DOM pollution, and data exfiltration vectors.
 */
const BLOCKED_IDENTIFIERS = new Set([
  "eval",
  "Function",         // new Function("…") – dynamic eval
  "execScript",       // IE legacy
  "document",
  "window",
  "globalThis",
  "self",
  "frames",
  "parent",
  "top",
  "location",
  "history",
  "navigator",
  "screen",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "openDatabase",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
  "ServiceWorker",
  "importScripts",
  "require",          // no arbitrary require() inside generated code
  "process",          // no process.env leakage
  "__dirname",
  "__filename",
]);

/**
 * JSX prop names that allow raw HTML injection.
 */
const BLOCKED_JSX_PROPS = new Set([
  "dangerouslySetInnerHTML",
  "innerHTML",
  "outerHTML",
]);

/**
 * Member expression patterns:  object.property  that are blocked
 * even when the object identifier itself might be aliased.
 * Stored as "object.property" strings matched against the AST.
 */
const BLOCKED_MEMBER_EXPRESSIONS = new Set([
  "document.cookie",
  "document.write",
  "document.writeln",
  "document.domain",
  "document.location",
  "window.location",
  "window.eval",
  "location.href",
  "location.replace",
  "location.assign",
  "history.pushState",
  "history.replaceState",
  "navigator.sendBeacon",
  "process.env",
  "process.exit",
  "process.binding",
  "process.mainModule",
]);

// ──────────────────────────────────────────────
//  Babel Parser Options
// ──────────────────────────────────────────────

const PARSER_OPTIONS = {
  sourceType: "module",
  plugins: [
    "jsx",
    "typescript",   // tolerate optional TS annotations gracefully
    "classProperties",
    "optionalChaining",
    "nullishCoalescingOperator",
  ],
  errorRecovery: false,  // fail fast on syntax errors – we don't want partial ASTs
};

// ──────────────────────────────────────────────
//  Main Validator
// ──────────────────────────────────────────────

/**
 * validateAST(code)
 *
 * @param {string} code – Raw JSX/JS string from the LLM
 * @returns {{ valid: boolean, code?: string, error?: string }}
 */
function validateAST(code) {
  if (!code || typeof code !== "string") {
    return { valid: false, error: "No code string provided to validator." };
  }

  // ── 1. Strip accidental markdown fences ────────────────────────────────
  const stripped = stripMarkdownFences(code);

  // ── 2. Parse into AST ──────────────────────────────────────────────────
  let ast;
  try {
    ast = parser.parse(stripped, PARSER_OPTIONS);
  } catch (parseErr) {
    return {
      valid: false,
      error: `Syntax error at line ${parseErr.loc?.line ?? "?"}:${parseErr.loc?.column ?? "?"} – ${parseErr.reasonCode ?? parseErr.message}`,
    };
  }

  // ── 3. Traverse & enforce security policy ─────────────────────────────
  let violation = null;

  try {
    traverse(ast, {
      // Block dangerous top-level / free identifiers
      Identifier(path) {
        if (BLOCKED_IDENTIFIERS.has(path.node.name)) {
          // Allow identifiers that appear as object *properties* in
          // member expressions (e.g. obj.fetch is caught separately).
          // Block all other uses (call expressions, variable declarations, etc.)
          if (
            path.parent.type === "MemberExpression" &&
            path.parent.property === path.node &&
            !path.parent.computed
          ) {
            // This is `something.fetch` – checked via member expression rule
            return;
          }
          violation = `Blocked identifier "${path.node.name}" found at line ${path.node.loc?.start?.line ?? "?"}.`;
          path.stop();
        }
      },

      // Block dangerous member expression combos (e.g. document.cookie)
      MemberExpression(path) {
        const { object, property, computed } = path.node;

        if (computed) return; // dynamic access like obj[key] – skip for now

        const objName  = object.type  === "Identifier" ? object.name  : null;
        const propName = property.type === "Identifier" ? property.name : null;

        if (objName && propName) {
          const combo = `${objName}.${propName}`;
          if (BLOCKED_MEMBER_EXPRESSIONS.has(combo)) {
            violation = `Blocked member expression "${combo}" at line ${path.node.loc?.start?.line ?? "?"}.`;
            path.stop();
          }
        }
      },

      // Block dangerous JSX attribute names
      JSXAttribute(path) {
        const nameNode = path.node.name;
        const attrName =
          nameNode.type === "JSXIdentifier"
            ? nameNode.name
            : nameNode.type === "JSXNamespacedName"
            ? `${nameNode.namespace.name}:${nameNode.name.name}`
            : null;

        if (attrName && BLOCKED_JSX_PROPS.has(attrName)) {
          violation = `Blocked JSX prop "${attrName}" at line ${path.node.loc?.start?.line ?? "?"}.`;
          path.stop();
        }
      },

      // Block new Function(...) and new Worker(...) patterns
      NewExpression(path) {
        const callee = path.node.callee;
        if (callee.type === "Identifier" && BLOCKED_IDENTIFIERS.has(callee.name)) {
          violation = `Blocked "new ${callee.name}(...)" at line ${path.node.loc?.start?.line ?? "?"}.`;
          path.stop();
        }
      },

      // Block template literals used to call eval-like functions
      TaggedTemplateExpression(path) {
        const tag = path.node.tag;
        if (tag.type === "Identifier" && BLOCKED_IDENTIFIERS.has(tag.name)) {
          violation = `Blocked tagged template expression with "${tag.name}" at line ${path.node.loc?.start?.line ?? "?"}.`;
          path.stop();
        }
      },
    });
  } catch (traverseErr) {
    // path.stop() throws internally in some @babel/traverse versions
    // when used inside try/catch – we catch that here safely.
    if (violation) {
      /* expected – fall through to return below */
    } else {
      return {
        valid: false,
        error: `Unexpected traversal error: ${traverseErr.message}`,
      };
    }
  }

  if (violation) {
    return { valid: false, error: `Security policy violation – ${violation}` };
  }

  // ── 4. Confirm expected export / function structure ────────────────────
  const structureCheck = checkExpectedStructure(ast);
  if (!structureCheck.ok) {
    return { valid: false, error: structureCheck.reason };
  }

  return { valid: true, code: stripped };
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Remove ```jsx / ```javascript / ``` fences the LLM sometimes emits.
 */
function stripMarkdownFences(code) {
  return code
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

/**
 * Verify the generated code actually contains a React functional component
 * named HealedWizard (either as a function declaration or arrow function
 * assigned to a const / let / var).
 */
function checkExpectedStructure(ast) {
  let foundHealedWizard = false;

  traverse(ast, {
    // function HealedWizard() { ... }
    FunctionDeclaration(path) {
      if (path.node.id?.name === "HealedWizard") {
        foundHealedWizard = true;
        path.stop();
      }
    },
    // const HealedWizard = () => { ... }   or   const HealedWizard = function() { ... }
    VariableDeclarator(path) {
      if (
        path.node.id?.name === "HealedWizard" &&
        (path.node.init?.type === "ArrowFunctionExpression" ||
          path.node.init?.type === "FunctionExpression")
      ) {
        foundHealedWizard = true;
        path.stop();
      }
    },
  });

  if (!foundHealedWizard) {
    return {
      ok: false,
      reason:
        'Generated code does not define a React component named "HealedWizard". ' +
        "Ensure the LLM prompt is correctly enforcing the component name.",
    };
  }

  return { ok: true };
}

module.exports = { validateAST };

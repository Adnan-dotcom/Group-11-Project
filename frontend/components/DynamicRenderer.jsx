"use client";
/**
 * DynamicRenderer.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Receives a raw JSX string from the server, transpiles it in-browser with
 * @babel/standalone, executes the resulting component, and renders it inside
 * a Framer Motion <AnimatePresence> for smooth enter/exit transitions.
 *
 * Props
 *   code        {string | null}  – Raw JSX source (e.g. "function UI({...}){...}")
 *   formData    {object}         – Live form state to inject into the component
 *   onUpdate    {function}       – Callback the generated component can call with
 *                                  partial form-field updates
 *   onReset     {function}       – Lets the generated UI trigger a full reset
 */

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

// Lazy-load Babel to avoid blocking the main bundle
let babelLoaded = false;
async function ensureBabel() {
  if (babelLoaded || typeof window === "undefined") return;
  if (window.Babel) { babelLoaded = true; return; }
  await import("@babel/standalone");
  babelLoaded = true;
}

// ── Transition presets ────────────────────────────────────────────────────────
const ENTER  = { opacity: 1, y: 0,   scale: 1,    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } };
const EXIT   = { opacity: 0, y: -24, scale: 0.97, transition: { duration: 0.3,  ease: "easeIn" } };
const INITIAL= { opacity: 0, y: 32,  scale: 0.97 };

// ── Error boundary ────────────────────────────────────────────────────────────
class RenderErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <FallbackPanel
          title="Runtime Error in Generated UI"
          message={this.state.error.message}
          onReset={this.props.onReset}
        />
      );
    }
    return this.props.children;
  }
}

// ── Shared fallback panel ─────────────────────────────────────────────────────
function FallbackPanel({ title, message, onReset }) {
  return (
    <motion.div
      key="fallback"
      initial={INITIAL} animate={ENTER} exit={EXIT}
      className="rounded-2xl bg-red-950/60 border border-red-700 p-6 space-y-4"
    >
      <div className="flex items-center gap-3">
        <span className="text-2xl">⚠️</span>
        <h3 className="text-red-300 font-bold text-lg">{title}</h3>
      </div>
      <p className="text-red-400 text-sm font-mono break-words">{message}</p>
      <p className="text-gray-400 text-sm">
        AuraGen is falling back to the original form. The server error has been logged.
      </p>
      {onReset && (
        <button
          onClick={onReset}
          className="mt-2 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition"
        >
          ← Return to Original Form
        </button>
      )}
    </motion.div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DynamicRenderer({ code, formData, onUpdate, onReset }) {
  const [DynComp, setDynComp] = useState(null);
  const [transpileError, setTranspileError] = useState(null);
  const codeRef = useRef(null);

  useEffect(() => {
    if (!code) {
      setDynComp(null);
      setTranspileError(null);
      return;
    }
    if (code === codeRef.current) return; // skip identical code
    codeRef.current = code;

    let cancelled = false;

    (async () => {
      try {
        await ensureBabel();

        // Strip ES module import/export statements since code runs inside a function wrapper
        const sanitizedCode = code
          .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, "")
          .replace(/^\s*export\s+default\s+\w+;?\s*$/gm, "");

        // Wrap the incoming JSX in a module-style IIFE that returns the component
        const wrapped = `
          const React = arguments[0];
          const { useState, useEffect, useRef, useCallback } = React;
          const motion = arguments[1];
          ${sanitizedCode}
          return typeof HealedWizard !== 'undefined' ? HealedWizard
               : typeof GeneratedUI  !== 'undefined' ? GeneratedUI
               : typeof UI           !== 'undefined' ? UI
               : null;
        `;

        // Transpile JSX → plain JS
        const { code: transpiledCode } = window.Babel.transform(wrapped, {
          presets: ["react"],
          filename: "dynamic.jsx",
        });

        // Execute in a sandboxed Function (no eval)
        // eslint-disable-next-line no-new-func
        const factory = new Function(transpiledCode);
        const Component = factory(React, motion);

        if (typeof Component !== "function") {
          throw new Error(
            "Generated code must define a function named `HealedWizard`, `GeneratedUI`, or `UI`."
          );
        }

        if (!cancelled) {
          setTranspileError(null);
          setDynComp(() => Component);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[DynamicRenderer] transpile error:", err);
          setTranspileError(err.message || String(err));
          setDynComp(null);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [code]);

  return (
    <AnimatePresence mode="wait">
      {transpileError ? (
        <FallbackPanel
          key="transpile-err"
          title="Transpilation Error"
          message={transpileError}
          onReset={onReset}
        />
      ) : DynComp ? (
        <motion.div
          key="dynamic-comp"
          initial={INITIAL} animate={ENTER} exit={EXIT}
          className="w-full"
        >
          <RenderErrorBoundary onReset={onReset}>
            <DynComp formData={formData} onUpdate={onUpdate} onReset={onReset} />
          </RenderErrorBoundary>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

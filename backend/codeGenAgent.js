/**
 * codeGenAgent.js – AuraGen Code-Generation Agent
 * ─────────────────────────────────────────────────
 * Uses LangChain with the configured LLM provider (OpenAI / Azure / Ollama)
 * to generate a React functional component (`HealedWizard`) that transforms
 * high-cognitive-load forms into a calm, conversational step-by-step wizard.
 *
 * Features:
 *  - Strict system prompt enforcing valid JSX, Tailwind CSS, no markdown fences
 *  - In-memory prompt-keyed cache (TTL-based) to slash latency on repeated inputs
 *  - Deterministic low-temperature sampling for consistent, reviewable code
 *  - Multiple provider support: openai | azure | ollama  (set via .env)
 */

"use strict";

require("dotenv").config();

const { ChatOpenAI }     = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");

// ──────────────────────────────────────────────
//  LLM Factory
// ──────────────────────────────────────────────

/**
 * Build the LangChain chat model based on LLM_PROVIDER env variable.
 * Called once at module load; the model is reused across all requests.
 */
function buildLLM() {
  const provider    = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  const temperature = parseFloat(process.env.LLM_TEMPERATURE ?? "0.3");
  const maxTokens   = parseInt(process.env.LLM_MAX_TOKENS   ?? "2048", 10);

  console.log(`[CodeGenAgent] Initialising LLM provider: ${provider}`);

  switch (provider) {
    case "azure":
      return new ChatOpenAI({
        azureOpenAIApiKey:            process.env.AZURE_OPENAI_API_KEY,
        azureOpenAIApiInstanceName:   process.env.AZURE_OPENAI_ENDPOINT?.replace(/https?:\/\//, "").replace(/\.openai\.azure\.com\/?$/, ""),
        azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
        azureOpenAIApiVersion:        process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-15-preview",
        temperature,
        maxTokens,
      });

    case "ollama":
      // Ollama exposes an OpenAI-compatible endpoint locally.
      return new ChatOpenAI({
        openAIApiKey:  "ollama",           // any non-empty string
        modelName:     process.env.OLLAMA_MODEL ?? "llama3",
        configuration: { baseURL: `${process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"}/v1` },
        temperature,
        maxTokens,
      });

    case "openai":
    default:
      return new ChatOpenAI({
        openAIApiKey: process.env.OPENAI_API_KEY,
        modelName:    process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        temperature,
        maxTokens,
      });
  }
}

// Singleton LLM instance
const llm = buildLLM();

// ──────────────────────────────────────────────
//  Prompt Templates
// ──────────────────────────────────────────────

/**
 * SYSTEM_PROMPT
 *
 * Hard rules the model must follow to produce safe, renderable JSX.
 * Keep this prompt tight – every token costs latency.
 */
const SYSTEM_PROMPT = `You are AuraGen's code-generation engine.
Your ONLY task is to output a single, self-contained React functional component called HealedWizard.

RULES – you MUST follow every rule without exception:

1. OUTPUT FORMAT
   - Return raw JSX/JavaScript only. No markdown, no code fences (\`\`\`), no explanations.
   - Start directly with import statements or the component definition.
   - End with: export default HealedWizard;

2. COMPONENT STRUCTURE
   - Named exactly: HealedWizard
   - Functional component using React hooks (useState, useEffect as needed).
   - Breaks the provided form fields into a calm, step-by-step conversational wizard.
   - Each step shows ONE or TWO related fields maximum – never overwhelm the user.
   - Include a progress indicator (e.g. "Step 2 of 5") and Back / Next / Submit buttons.
   - On the final step, call props.onSubmit(collectedData) with all field values.

3. STYLING
   - Use Tailwind CSS utility classes exclusively. No inline style={{ }} objects.
   - Design aesthetic: calm, airy, trust-inducing. Prefer whites, soft blues, gentle grays.
   - Buttons: rounded-2xl with gentle hover transitions (transition-all duration-200).
   - Inputs: border border-gray-300 rounded-xl px-4 py-2 w-full focus:ring-2 focus:ring-blue-400 outline-none

4. PRE-FILLED VALUES
   - currentState contains any values the user has already entered.
   - Seed each field's initial useState value from currentState so progress is not lost.

5. SECURITY – HARD PROHIBITIONS (violation = rejection):
   - No eval(), new Function(), setTimeout with string arg, setInterval with string arg.
   - No dangerouslySetInnerHTML, innerHTML, outerHTML.
   - No document, window, localStorage, sessionStorage, globalThis.
   - No fetch(), XMLHttpRequest, WebSocket, or any network calls.
   - No require(), import() dynamic imports, or external script tags.
   - No process.env access.

6. REACT IMPORTS
   - Always include: import React, { useState } from 'react';
   - Only import from 'react'. No other library imports.

7. PROPS INTERFACE
   - Accept a single props object: { formFields, currentState, onSubmit }
   - formFields: array of { name, label, type, placeholder, required, options? }
   - currentState: object of already-entered values keyed by field name
   - onSubmit: function called with the final values object on completion

Produce clean, readable, production-quality code that a junior developer can maintain.`;

/**
 * buildUserPrompt(score, formFields, currentState)
 *
 * Constructs the human turn message sent alongside the system prompt.
 *
 * @param {number} score        – Cognitive-load friction score (0–100)
 * @param {Array}  formFields   – Array of field descriptors
 * @param {Object} currentState – Already-entered field values
 */
function buildUserPrompt(score, formFields, currentState) {
  const fieldsJson = JSON.stringify(formFields, null, 2);
  const stateJson  = JSON.stringify(currentState ?? {}, null, 2);

  return `A friction_alert was triggered with a cognitive-load score of ${score}/100.

The user is currently on a form with these fields:
${fieldsJson}

The user has already entered these values (preserve them in the wizard):
${stateJson}

Generate the HealedWizard component now. Output raw JSX only.`;
}

// ──────────────────────────────────────────────
//  In-Memory Cache (TTL-based)
// ──────────────────────────────────────────────

const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS ?? "300", 10) * 1000;

/**
 * Simple LRU-lite cache: Map preserves insertion order.
 * Keys are deterministic hashes of the prompt inputs.
 * Max 50 entries to bound memory in demo environments.
 */
const cache = new Map();
const CACHE_MAX_SIZE = 50;

/**
 * Create a stable cache key from the generation inputs.
 * We stringify + hash loosely to avoid deep equality issues.
 */
function makeCacheKey(score, formFields, currentState) {
  // Round score to nearest 5 for cache-friendliness (scores of 72 & 73 → same wizard)
  const roundedScore = Math.round(score / 5) * 5;
  return JSON.stringify({ roundedScore, formFields, currentState });
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_SIZE) {
    // Evict oldest entry
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { value, ts: Date.now() });
}

// ──────────────────────────────────────────────
//  Wizard Meta Builder
// ──────────────────────────────────────────────

/**
 * Build lightweight metadata about the generated wizard to send alongside
 * the code so the frontend can render labels / progress bars correctly.
 *
 * @param {Array}  formFields
 * @param {number} score
 * @returns {Object} wizardMeta
 */
function buildWizardMeta(formFields, score) {
  // Group fields into steps: max 2 related fields per step
  const steps = [];
  for (let i = 0; i < formFields.length; i += 2) {
    steps.push(formFields.slice(i, i + 2).map((f) => f.name));
  }

  return {
    totalSteps:    steps.length,
    steps,
    frictionScore: score,
    generatedAt:   new Date().toISOString(),
    provider:      process.env.LLM_PROVIDER ?? "openai",
    model:         process.env.OPENAI_MODEL ?? process.env.OLLAMA_MODEL ?? process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME ?? "unknown",
  };
}

// ──────────────────────────────────────────────
//  Main Code-Gen Function
// ──────────────────────────────────────────────

/**
 * generateHealedWizard({ score, formFields, currentState })
 *
 * @param {Object} params
 * @param {number} params.score        – Friction/cognitive-load score (0–100)
 * @param {Array}  params.formFields   – Form field descriptors
 * @param {Object} params.currentState – Already-entered values
 *
 * @returns {Promise<{ code: string, wizardMeta: Object }>}
 * @throws  {Error} if generation fails
 */
async function generateHealedWizard({ score, formFields, currentState }) {
  // ── Input validation ──────────────────────────────────────────────────
  if (!Array.isArray(formFields) || formFields.length === 0) {
    throw new Error("formFields must be a non-empty array of field descriptors.");
  }

  // ── Cache lookup ──────────────────────────────────────────────────────
  const cacheKey = makeCacheKey(score, formFields, currentState);
  const cached   = cacheGet(cacheKey);

  if (cached) {
    console.log(`[CodeGenAgent] Cache HIT (key length: ${cacheKey.length})`);
    return cached;
  }

  console.log(`[CodeGenAgent] Cache MISS – invoking LLM (score=${score}, fields=${formFields.length})`);
  const startTime = Date.now();

  // ── LLM Invocation ───────────────────────────────────────────────────
  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(buildUserPrompt(score, formFields, currentState)),
  ];

  let rawContent;
  try {
    const response = await llm.invoke(messages);
    rawContent     = response.content;
  } catch (llmErr) {
    // Surface a clean error with context instead of raw LangChain internals
    const hint = llmErr.message?.includes("API key")
      ? "Check OPENAI_API_KEY / LLM provider env variables in .env"
      : llmErr.message ?? "Unknown LLM error";
    throw new Error(`LLM invocation failed: ${hint}`);
  }

  const latencyMs = Date.now() - startTime;
  console.log(`[CodeGenAgent] LLM responded in ${latencyMs}ms`);

  if (!rawContent || typeof rawContent !== "string") {
    throw new Error("LLM returned an empty or non-string response.");
  }

  // ── Build result ──────────────────────────────────────────────────────
  const wizardMeta = buildWizardMeta(formFields, score);
  const result     = { code: rawContent.trim(), wizardMeta, latencyMs };

  // ── Cache store ───────────────────────────────────────────────────────
  cacheSet(cacheKey, result);

  return result;
}

module.exports = { generateHealedWizard };

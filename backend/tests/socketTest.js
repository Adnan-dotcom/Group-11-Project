/**
 * tests/socketTest.js – Socket.io Integration Test
 * ──────────────────────────────────────────────────
 * Sends a friction_alert to a running AuraGen backend and validates
 * the response. Requires a live server + a valid API key in .env.
 *
 * Usage:
 *   # In terminal 1:  npm run dev
 *   # In terminal 2:  npm run test:socket
 */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { io: ClientIO } = require("socket.io-client");

// ── Config ────────────────────────────────────────────────────────────────
const SERVER_URL = `http://localhost:${process.env.PORT ?? 4000}`;
const TIMEOUT_MS = 60000; // 60 s – LLM can be slow on first call

// ── ANSI helpers ──────────────────────────────────────────────────────────
const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM    = (s) => `\x1b[2m${s}\x1b[0m`;

// ── Test scenarios ────────────────────────────────────────────────────────

/**
 * SCENARIO A – Happy path
 * A realistic medical intake form with 6 fields and partial currentState.
 * Expects: ui_morph with valid code and wizardMeta
 */
const SCENARIO_A = {
  name: "Happy path – medical intake form",
  event: "friction_alert",
  payload: {
    score: 82,
    formFields: [
      { name: "fullName",      label: "Full Name",          type: "text",   required: true,  placeholder: "Jane Doe" },
      { name: "dob",           label: "Date of Birth",      type: "date",   required: true  },
      { name: "email",         label: "Email Address",      type: "email",  required: true,  placeholder: "jane@example.com" },
      { name: "phone",         label: "Phone Number",       type: "tel",    required: false, placeholder: "+1 555 000 0000" },
      { name: "insuranceId",   label: "Insurance ID",       type: "text",   required: false },
      { name: "reasonForVisit",label: "Reason for Visit",   type: "textarea",required: true, placeholder: "Brief description…" },
    ],
    currentState: {
      fullName: "Jane Doe",
      email:    "jane@example.com",
    },
  },
  expect: "ui_morph",
};

/**
 * SCENARIO B – Invalid payload (bad score)
 * Expects: ui_fallback with INVALID_PAYLOAD
 */
const SCENARIO_B = {
  name: "Invalid payload – score out of range",
  event: "friction_alert",
  payload: {
    score:      150,   // invalid – out of 0-100
    formFields: [{ name: "x", label: "X", type: "text", required: false }],
    currentState: {},
  },
  expect: "ui_fallback",
  expectError: "INVALID_PAYLOAD",
};

/**
 * SCENARIO C – Invalid payload (no formFields)
 * Expects: ui_fallback with INVALID_PAYLOAD
 */
const SCENARIO_C = {
  name: "Invalid payload – missing formFields",
  event: "friction_alert",
  payload: {
    score:        70,
    formFields:   [],   // empty array
    currentState: {},
  },
  expect: "ui_fallback",
  expectError: "INVALID_PAYLOAD",
};

const SCENARIOS = [SCENARIO_A, SCENARIO_B, SCENARIO_C];

// ──────────────────────────────────────────────
//  Runner
// ──────────────────────────────────────────────

async function runScenario(socket, scenario, index) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    console.log(`\n${BOLD(`[${index + 1}/${SCENARIOS.length}]`)} ${YELLOW(scenario.name)}`);
    console.log(DIM(`  Sending ${scenario.event} → expecting ${scenario.expect}`));

    const timer = setTimeout(() => {
      console.log(RED(`  ✗ TIMEOUT after ${TIMEOUT_MS / 1000}s`));
      resolve({ ok: false, name: scenario.name, reason: "timeout" });
    }, TIMEOUT_MS);

    // Listen for BOTH possible response events
    function onMorph(data) {
      clearTimeout(timer);
      socket.off("ui_morph",    onMorph);
      socket.off("ui_fallback", onFallback);

      const elapsed = Date.now() - startTime;

      if (scenario.expect !== "ui_morph") {
        console.log(RED(`  ✗ Expected ui_fallback but got ui_morph`));
        return resolve({ ok: false, name: scenario.name, reason: "unexpected ui_morph" });
      }

      // Validate ui_morph shape
      const issues = [];
      if (typeof data.code !== "string" || data.code.length < 50)
        issues.push("code is missing or too short");
      if (typeof data.compiledCode !== "string")
        issues.push("compiledCode is missing");
      if (!data.wizardMeta || typeof data.wizardMeta.totalSteps !== "number")
        issues.push("wizardMeta.totalSteps is missing");
      if (!data.wizardMeta?.generatedAt)
        issues.push("wizardMeta.generatedAt is missing");

      if (issues.length > 0) {
        console.log(RED(`  ✗ ui_morph shape invalid: ${issues.join(", ")}`));
        return resolve({ ok: false, name: scenario.name, reason: issues.join(", ") });
      }

      console.log(GREEN(`  ✓ ui_morph received in ${elapsed}ms`));
      console.log(DIM(`    steps=${data.wizardMeta.totalSteps}  model=${data.wizardMeta.model}  score=${data.wizardMeta.frictionScore}`));
      console.log(DIM(`    code preview: ${data.code.slice(0, 80).replace(/\n/g, " ")}…`));
      resolve({ ok: true, name: scenario.name });
    }

    function onFallback(data) {
      clearTimeout(timer);
      socket.off("ui_morph",    onMorph);
      socket.off("ui_fallback", onFallback);

      const elapsed = Date.now() - startTime;

      if (scenario.expect !== "ui_fallback") {
        console.log(RED(`  ✗ Expected ui_morph but got ui_fallback: ${data.error} – ${data.reason}`));
        return resolve({ ok: false, name: scenario.name, reason: data.reason });
      }

      if (scenario.expectError && data.error !== scenario.expectError) {
        console.log(RED(`  ✗ Expected error="${scenario.expectError}" but got "${data.error}"`));
        return resolve({ ok: false, name: scenario.name, reason: `wrong error code: ${data.error}` });
      }

      console.log(GREEN(`  ✓ ui_fallback received in ${elapsed}ms`));
      console.log(DIM(`    error=${data.error}  reason=${data.reason}`));
      resolve({ ok: true, name: scenario.name });
    }

    socket.on("ui_morph",    onMorph);
    socket.on("ui_fallback", onFallback);

    // Fire the event
    socket.emit(scenario.event, scenario.payload);
  });
}

async function main() {
  console.log(BOLD("\n── AuraGen Socket Integration Tests ──"));
  console.log(DIM(`Server: ${SERVER_URL}\n`));

  // Check health first
  try {
    const http = require("http");
    await new Promise((resolve, reject) => {
      http.get(`${SERVER_URL}/health`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            console.log(GREEN(`Server healthy: ${json.status} (uptime ${json.uptime}s)\n`));
            resolve();
          } catch {
            reject(new Error("Could not parse /health response"));
          }
        });
      }).on("error", reject);
    });
  } catch (err) {
    console.log(RED(`\nCannot reach server at ${SERVER_URL}`));
    console.log(RED(`Make sure the server is running: npm run dev\n`));
    console.log(RED(`Error: ${err.message}\n`));
    process.exit(1);
  }

  // Connect socket
  const socket = ClientIO(SERVER_URL, {
    transports: ["websocket"],
    reconnection: false,
  });

  await new Promise((resolve, reject) => {
    socket.on("connect", () => {
      console.log(DIM(`Connected with socket id: ${socket.id}\n`));
      resolve();
    });
    socket.on("connect_error", reject);
    setTimeout(() => reject(new Error("Socket connect timeout")), 5000);
  });

  // Run scenarios sequentially (avoid race conditions on shared socket)
  const results = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    const result = await runScenario(socket, SCENARIOS[i], i);
    results.push(result);
  }

  socket.disconnect();

  // Summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const total  = results.length;

  console.log(`\n${"─".repeat(44)}`);
  console.log(BOLD(`Results: ${passed}/${total} passed`));

  if (failed.length > 0) {
    failed.forEach((r) => console.log(RED(`  ✗ ${r.name}: ${r.reason}`)));
    console.log();
    process.exit(1);
  } else {
    console.log(GREEN(`  All socket tests passed ✓\n`));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(RED(`\nFatal error: ${err.message}\n`));
  process.exit(1);
});

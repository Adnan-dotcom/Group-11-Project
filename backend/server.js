/**
 * server.js – AuraGen Socket.io Server
 * ──────────────────────────────────────
 * Entry point for the AuraGen backend.
 *
 * Socket events:
 *   INCOMING  friction_alert  { score, formFields, currentState }
 *   OUTGOING  ui_morph        { code, compiledCode, wizardMeta }
 *   OUTGOING  ui_fallback     { error, reason }
 *
 * HTTP endpoints (health checks / debug):
 *   GET /health   → { status, uptime, connections }
 *   GET /cache    → { cacheSize }  (dev only)
 */

"use strict";

require("dotenv").config();

const express   = require("express");
const http      = require("http");
const cors      = require("cors");
const { Server } = require("socket.io");

const { generateHealedWizard } = require("./codeGenAgent");
const { validateAST }          = require("./astValidator");

// ──────────────────────────────────────────────
//  Configuration
// ──────────────────────────────────────────────

const PORT            = parseInt(process.env.PORT ?? "4000", 10);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";

// ──────────────────────────────────────────────
//  Express + HTTP Server
// ──────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(cors({ origin: FRONTEND_ORIGIN, methods: ["GET"] }));
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status:      "ok",
    service:     "auragen-backend",
    uptime:      Math.floor(process.uptime()),
    connections: io ? io.engine.clientsCount : 0,
    timestamp:   new Date().toISOString(),
  });
});

// ── Debug: cache size (disable in production) ────────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.get("/debug/cache", (_req, res) => {
    // We import the cache indirectly via the agent module's closure.
    // This endpoint is intentionally lightweight – just signals it's alive.
    res.json({ message: "Cache info is managed inside codeGenAgent.js." });
  });
}

// ──────────────────────────────────────────────
//  Socket.io Server
// ──────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin:  FRONTEND_ORIGIN,
    methods: ["GET", "POST"],
  },
  // Ping settings for stable demo connections
  pingTimeout:  60000,
  pingInterval: 25000,
});

// ──────────────────────────────────────────────
//  Logging helpers
// ──────────────────────────────────────────────

/**
 * Structured log emitter – keeps demo console readable at a glance.
 * Format: [HH:MM:SS] [LEVEL] [CONTEXT] message
 */
function log(level, context, message, extra) {
  const time = new Date().toTimeString().slice(0, 8);
  const prefix = `[${time}] [${level.padEnd(5)}] [${context}]`;
  if (extra !== undefined) {
    console.log(prefix, message, extra);
  } else {
    console.log(prefix, message);
  }
}

const logInfo  = (ctx, msg, extra) => log("INFO",  ctx, msg, extra);
const logWarn  = (ctx, msg, extra) => log("WARN",  ctx, msg, extra);
const logError = (ctx, msg, extra) => log("ERROR", ctx, msg, extra);

// ──────────────────────────────────────────────
//  Input Sanitisation
// ──────────────────────────────────────────────

/**
 * Validate the shape of an incoming friction_alert payload.
 * Returns { ok: true, payload } or { ok: false, reason }.
 */
function sanitiseFrictionAlert(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "Payload must be a JSON object." };
  }

  const { score, formFields, currentState } = data;

  if (typeof score !== "number" || score < 0 || score > 100) {
    return { ok: false, reason: `"score" must be a number between 0 and 100 (received: ${score}).` };
  }

  if (!Array.isArray(formFields) || formFields.length === 0) {
    return { ok: false, reason: '"formFields" must be a non-empty array.' };
  }

  // Validate each field has at minimum a name and label
  for (let i = 0; i < formFields.length; i++) {
    const f = formFields[i];
    if (!f || typeof f.name !== "string" || typeof f.label !== "string") {
      return {
        ok: false,
        reason: `formFields[${i}] must have string "name" and "label" properties.`,
      };
    }
  }

  // currentState is optional – default to empty object
  const sanitisedState = (currentState && typeof currentState === "object" && !Array.isArray(currentState))
    ? currentState
    : {};

  return {
    ok: true,
    payload: { score, formFields, currentState: sanitisedState },
  };
}

// ──────────────────────────────────────────────
//  Core Event Handler
// ──────────────────────────────────────────────

/**
 * handleFrictionAlert
 *
 * Orchestrates: validate input → generate code → AST safety check → emit result.
 *
 * @param {import('socket.io').Socket} socket
 * @param {Object} rawData  – Raw socket payload
 */
async function handleFrictionAlert(socket, rawData) {
  const clientId = socket.id.slice(0, 8); // shortened for log readability

  logInfo("SOCKET", `friction_alert from [${clientId}]`, { score: rawData?.score });

  // ── 1. Validate / sanitise input ─────────────────────────────────────
  const { ok, reason, payload } = sanitiseFrictionAlert(rawData);

  if (!ok) {
    logWarn("SOCKET", `Bad payload from [${clientId}]: ${reason}`);
    socket.emit("ui_fallback", {
      error:  "INVALID_PAYLOAD",
      reason,
    });
    return;
  }

  const { score, formFields, currentState } = payload;

  // ── 2. Code generation ───────────────────────────────────────────────
  let generationResult;
  try {
    generationResult = await generateHealedWizard({ score, formFields, currentState });
  } catch (genErr) {
    logError("CODEGEN", `Generation failed for [${clientId}]: ${genErr.message}`);
    socket.emit("ui_fallback", {
      error:  "GENERATION_FAILED",
      reason: genErr.message,
    });
    return;
  }

  const { code, wizardMeta, latencyMs } = generationResult;

  logInfo("CODEGEN", `Generated in ${latencyMs ?? "?"}ms for [${clientId}] – ${wizardMeta.totalSteps} steps`);

  // ── 3. AST Safety Validation ─────────────────────────────────────────
  const astResult = validateAST(code);

  if (!astResult.valid) {
    logWarn("AST", `Validation FAILED for [${clientId}]: ${astResult.error}`);
    socket.emit("ui_fallback", {
      error:  "AST_VALIDATION_FAILED",
      reason: astResult.error,
    });
    return;
  }

  logInfo("AST", `Validation PASSED for [${clientId}]`);

  // ── 4. Emit success ───────────────────────────────────────────────────
  // compiledCode: in this setup we emit the validated JSX string directly.
  // The frontend's Babel standalone / esbuild can compile it client-side.
  // If you need server-side Babel compilation, see the note in README.
  socket.emit("ui_morph", {
    code:         astResult.code,   // validated, stripped source
    compiledCode: astResult.code,   // placeholder – compile client-side
    wizardMeta,
  });

  logInfo("SOCKET", `ui_morph emitted to [${clientId}]`, {
    frictionScore: score,
    steps:         wizardMeta.totalSteps,
  });
}

// ──────────────────────────────────────────────
//  Connection Lifecycle
// ──────────────────────────────────────────────

io.on("connection", (socket) => {
  const clientId = socket.id.slice(0, 8);
  logInfo("CONNECT", `Client [${clientId}] connected (total: ${io.engine.clientsCount})`);

  // ── Register event listeners ─────────────────────────────────────────
  socket.on("friction_alert", (data) => handleFrictionAlert(socket, data));

  // ── Ping/pong for connection health (optional – useful for demos) ────
  socket.on("ping_check", () => {
    socket.emit("pong_check", { ts: Date.now() });
  });

  // ── Disconnection ────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    logInfo("DISCONNECT", `Client [${clientId}] disconnected (${reason})`);
  });

  // ── Error handling ───────────────────────────────────────────────────
  socket.on("error", (err) => {
    logError("SOCKET", `Error on [${clientId}]: ${err.message}`);
  });
});

// ──────────────────────────────────────────────
//  Process-level error guards
// ──────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  logError("PROCESS", `Uncaught exception: ${err.message}`, err.stack);
});

process.on("unhandledRejection", (reason) => {
  logError("PROCESS", "Unhandled promise rejection:", reason);
});

// ──────────────────────────────────────────────
//  Boot
// ──────────────────────────────────────────────

server.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log(`║  AuraGen Backend  •  port ${PORT}             ║`);
  console.log(`║  CORS origin: ${FRONTEND_ORIGIN.padEnd(26)} ║`);
  console.log(`║  LLM provider: ${(process.env.LLM_PROVIDER ?? "openai").padEnd(25)} ║`);
  console.log("║  Ready – waiting for friction_alert...   ║");
  console.log("╚══════════════════════════════════════════╝\n");
});

module.exports = { app, server, io }; // exported for testing

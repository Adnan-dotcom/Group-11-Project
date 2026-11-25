# AuraGen Backend

Self-Healing Generative UI via Cognitive Load — Node.js / Express / Socket.io backend.

---

## Quick Start

```bash
# 1. Install dependencies
cd backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set OPENAI_API_KEY (or choose LLM_PROVIDER=ollama for local)

# 3. Start the server
npm run dev      # nodemon (hot-reload)
# or
npm start        # production
```

The server listens on **http://localhost:4000** (or `PORT` from `.env`).

---

## Architecture

```
frontend                       backend/
  │                              │
  │  socket.io  friction_alert   │
  │ ─────────────────────────►  server.js
  │                              │
  │                              ├─ codeGenAgent.js  (LangChain → LLM)
  │                              │
  │                              └─ astValidator.js  (@babel/parser + traverse)
  │
  │  socket.io  ui_morph         │
  │ ◄─────────────────────────  server.js
  │       or ui_fallback         │
```

### Modules

| File | Responsibility |
|------|---------------|
| `server.js` | Socket.io server, event routing, structured logging |
| `codeGenAgent.js` | LangChain LLM wrapper, prompt building, TTL cache |
| `astValidator.js` | Babel AST parse + traverse, security policy enforcement |

---

## Socket API

### Client → Server

**Event: `friction_alert`**

```json
{
  "score": 78,
  "formFields": [
    { "name": "fullName",  "label": "Full Name",  "type": "text", "required": true },
    { "name": "dob",       "label": "Date of Birth", "type": "date", "required": true },
    { "name": "email",     "label": "Email",       "type": "email", "required": true },
    { "name": "insurance", "label": "Insurance ID","type": "text",  "required": false }
  ],
  "currentState": {
    "fullName": "Jane Doe"
  }
}
```

### Server → Client

**Event: `ui_morph`** (success)

```json
{
  "code":         "<raw JSX string>",
  "compiledCode": "<same JSX – compile client-side with Babel standalone>",
  "wizardMeta": {
    "totalSteps": 2,
    "steps": [["fullName","dob"], ["email","insurance"]],
    "frictionScore": 78,
    "generatedAt": "2026-11-25T06:30:00.000Z",
    "provider": "openai",
    "model": "gpt-4o-mini"
  }
}
```

**Event: `ui_fallback`** (error)

```json
{
  "error":  "AST_VALIDATION_FAILED",
  "reason": "Security policy violation – Blocked identifier \"eval\" found at line 12."
}
```

Possible `error` codes:

| Code | Cause |
|------|-------|
| `INVALID_PAYLOAD` | Missing / malformed `friction_alert` fields |
| `GENERATION_FAILED` | LLM API error (bad key, timeout, quota) |
| `AST_VALIDATION_FAILED` | Syntax error or security policy violation in generated JSX |

---

## LLM Providers

Configure via `.env`:

| `LLM_PROVIDER` | Required env vars |
|---------------|-------------------|
| `openai` (default) | `OPENAI_API_KEY`, `OPENAI_MODEL` |
| `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_DEPLOYMENT_NAME` |
| `ollama` | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` (no key needed) |

---

## Running Tests

```bash
# AST validator unit tests (no server or API key required)
npm run test:ast

# Socket end-to-end test (requires server running + valid API key)
npm run test:socket
```

---

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Uptime + connection count |
| GET | `/debug/cache` | Cache info (dev only) |

---

## Security Model

The AST validator blocks:

- **Code execution**: `eval`, `new Function`, tagged template literals
- **DOM pollution**: `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`
- **Data exfiltration**: `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`
- **Storage access**: `localStorage`, `sessionStorage`, `document.cookie`
- **Process access**: `process.env`, `process.exit`, `require`
- **Window/global leakage**: `window`, `globalThis`, `document`, `location`

Any violation causes the server to emit `ui_fallback` instead of `ui_morph`.

---

## Git Workflow

```bash
git checkout -b backend-auragen
git add backend/
git commit -m "feat: add AuraGen backend (Socket.io + LangChain + AST validator)"
# PR → review → merge into main
```

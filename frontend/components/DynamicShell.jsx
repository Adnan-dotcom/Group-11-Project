"use client";
/**
 * DynamicShell.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities
 *   • Renders a dense, realistic tax / financial form (the "before" state).
 *   • Mounts a live telemetry HUD (Cognitive Load Score, status badge, mode).
 *   • Connects to ws://localhost:4000 via socket.io-client.
 *   • Emits  `friction_alert` → { score, formFields, currentState }
 *   • Listens `ui_morph`     → { code }   renders via DynamicRenderer
 *   • Listens `ui_fallback`  → { error }  shows inline error notice
 */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import DynamicRenderer from "./DynamicRenderer";
import { useCognitiveLoad } from "../hooks/useCognitiveLoad";
import clsx from "clsx";

const SOCKET_URL = "http://localhost:4000";

// ── Score colour helpers ──────────────────────────────────────────────────────
function scoreColor(s) {
  if (s < 40) return "#22c55e"; // green
  if (s < 70) return "#f59e0b"; // amber
  return "#ef4444";             // red
}
function scoreBg(s) {
  if (s < 40) return "bg-green-500/20 border-green-600 text-green-300";
  if (s < 70) return "bg-amber-500/20 border-amber-600 text-amber-300";
  return "bg-red-500/20 border-red-600 text-red-300";
}

// ── Telemetry HUD ─────────────────────────────────────────────────────────────
function TelemetryHUD({ score, isFrustrated, mode, socketStatus, onSimulate, onReset }) {
  const color = scoreColor(score);
  const badgeCls = scoreBg(score);

  return (
    <div className="hud-panel space-y-4 w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-aura-400 text-lg font-bold tracking-tight">⚡ AuraGen HUD</span>
          <span
            className={clsx(
              "text-xs font-mono px-2 py-0.5 rounded-full border",
              socketStatus === "connected"
                ? "bg-green-500/20 border-green-600 text-green-300"
                : socketStatus === "connecting"
                ? "bg-yellow-500/20 border-yellow-600 text-yellow-300"
                : "bg-gray-700 border-gray-600 text-gray-400"
            )}
          >
            {socketStatus}
          </span>
        </div>
        <span
          className={clsx(
            "text-xs font-semibold px-3 py-1 rounded-full border",
            mode === "morphed"
              ? "bg-aura-700/40 border-aura-500 text-aura-300"
              : "bg-gray-700 border-gray-600 text-gray-400"
          )}
        >
          {mode === "morphed" ? "🧠 AI-Morphed UI" : "📋 Static Form"}
        </span>
      </div>

      {/* Score bar */}
      <div>
        <div className="flex justify-between items-center mb-1.5">
          <span className="form-field-label">Cognitive Load Score</span>
          <span
            className="text-2xl font-black tabular-nums transition-colors"
            style={{ color }}
          >
            {score}
          </span>
        </div>
        <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full score-bar-fill"
            style={{ width: `${score}%`, backgroundColor: color }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-600 mt-1 font-mono">
          <span>0 — Calm</span>
          <span>70 — Threshold</span>
          <span>100 — 🔥</span>
        </div>
      </div>

      {/* Status badge */}
      <div className="flex items-center gap-3">
        <AnimatePresence mode="wait">
          {isFrustrated ? (
            <motion.div
              key="frustrated"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className={clsx("flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-semibold", badgeCls)}
            >
              <span className="animate-pulse">🚨</span> User Frustrated — Morphing UI…
            </motion.div>
          ) : (
            <motion.div
              key="calm"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-green-500/10 border-green-800 text-green-400 text-sm font-semibold"
            >
              ✅ Cognitive Load Normal
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-800">
        <button
          onClick={onSimulate}
          className="flex-1 min-w-[140px] py-2 px-3 rounded-lg bg-red-700 hover:bg-red-600 text-white text-xs font-bold tracking-wide transition active:scale-95"
        >
          🔥 Simulate High Friction
        </button>
        <button
          onClick={onReset}
          className="flex-1 min-w-[120px] py-2 px-3 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-xs font-bold tracking-wide transition active:scale-95"
        >
          ↺ Reset Load
        </button>
      </div>
    </div>
  );
}

// ── Dense Tax / Financial Form ────────────────────────────────────────────────
const INITIAL_FORM = {
  // Personal
  taxYear: "", filingStatus: "", ssn: "", spouseSsn: "",
  firstName: "", lastName: "", middleInitial: "",
  spouseFirstName: "", spouseLastName: "",
  address: "", apt: "", city: "", state: "", zip: "",
  occupation: "", spouseOccupation: "",
  // Income
  wages: "", taxableInterest: "", taxExemptInterest: "",
  qualifiedDividends: "", ordinaryDividends: "",
  iraDistributions: "", taxableIra: "",
  pensionAnnuities: "", taxablePension: "",
  socialSecurity: "", taxableSocialSecurity: "",
  capitalGainLoss: "", otherIncome: "",
  // Deductions
  adjustedGrossIncome: "", standardDeduction: "", qualifiedDeductible: "",
  taxableIncome: "", tentativeTax: "",
  childTaxCredit: "", earnedIncomeCredit: "", additionalChildTaxCredit: "",
  americanOpportunityCredit: "", otherCredits: "",
  // Tax
  selfEmploymentTax: "", unreportedSSTax: "", additionalMedicare: "",
  netInvestmentTax: "", otherTaxes: "", totalTax: "",
  federalWithheld: "", estimatedTaxPayments: "", refundableCredits: "",
  amountOwed: "", refund: "", routingNumber: "", accountNumber: "",
};

function FieldGroup({ title, children }) {
  return (
    <fieldset className="border border-gray-200 rounded-lg p-4 space-y-3">
      <legend className="text-xs font-black uppercase tracking-widest text-gray-500 px-2">
        {title}
      </legend>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{children}</div>
    </fieldset>
  );
}

function FormField({ label, name, value, onChange, type = "text", span = 1, placeholder = "" }) {
  return (
    <div className={clsx("flex flex-col", span === 2 && "col-span-2", span === 3 && "col-span-3")}>
      <label className="form-field-label">{label}</label>
      <input
        type={type}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="form-field-input"
      />
    </div>
  );
}

function TaxForm({ formData, onChange }) {
  return (
    <div className="space-y-5 text-gray-900">
      {/* Header */}
      <div className="bg-blue-900 text-white rounded-xl p-4 flex items-center justify-between">
        <div>
          <div className="text-xs font-mono uppercase tracking-widest text-blue-300">
            Form 1040 (Rev. 2024)
          </div>
          <div className="text-lg font-black">U.S. Individual Income Tax Return</div>
          <div className="text-blue-300 text-xs mt-0.5">
            Department of the Treasury — Internal Revenue Service (99)
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-blue-300">OMB No. 1545-0074</div>
          <div className="text-xs text-blue-300 mt-1">For the year Jan. 1–Dec. 31, 2024</div>
        </div>
      </div>

      <FieldGroup title="Filing Information">
        <FormField label="Tax Year" name="taxYear" value={formData.taxYear} onChange={onChange} placeholder="2024" />
        <FormField label="Filing Status" name="filingStatus" value={formData.filingStatus} onChange={onChange} placeholder="Single / MFJ / MFS…" />
        <FormField label="SSN (Primary)" name="ssn" value={formData.ssn} onChange={onChange} placeholder="XXX-XX-XXXX" />
        <FormField label="Spouse SSN" name="spouseSsn" value={formData.spouseSsn} onChange={onChange} placeholder="XXX-XX-XXXX" />
        <FormField label="First Name" name="firstName" value={formData.firstName} onChange={onChange} />
        <FormField label="M.I." name="middleInitial" value={formData.middleInitial} onChange={onChange} />
        <FormField label="Last Name" name="lastName" value={formData.lastName} onChange={onChange} />
        <FormField label="Spouse First Name" name="spouseFirstName" value={formData.spouseFirstName} onChange={onChange} />
        <FormField label="Spouse Last Name" name="spouseLastName" value={formData.spouseLastName} onChange={onChange} />
        <FormField label="Occupation" name="occupation" value={formData.occupation} onChange={onChange} />
        <FormField label="Spouse Occupation" name="spouseOccupation" value={formData.spouseOccupation} onChange={onChange} />
        <FormField label="Address" name="address" value={formData.address} onChange={onChange} span={2} />
        <FormField label="Apt / Suite" name="apt" value={formData.apt} onChange={onChange} />
        <FormField label="City" name="city" value={formData.city} onChange={onChange} />
        <FormField label="State" name="state" value={formData.state} onChange={onChange} />
        <FormField label="ZIP Code" name="zip" value={formData.zip} onChange={onChange} />
      </FieldGroup>

      <FieldGroup title="Income — Lines 1–8 (Schedule 1)">
        <FormField label="1. Wages, Salaries, Tips (W-2)" name="wages" value={formData.wages} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="2a. Tax-Exempt Interest" name="taxExemptInterest" value={formData.taxExemptInterest} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="2b. Taxable Interest" name="taxableInterest" value={formData.taxableInterest} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="3a. Qualified Dividends" name="qualifiedDividends" value={formData.qualifiedDividends} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="3b. Ordinary Dividends" name="ordinaryDividends" value={formData.ordinaryDividends} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="4a. IRA Distributions" name="iraDistributions" value={formData.iraDistributions} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="4b. Taxable Amount (IRA)" name="taxableIra" value={formData.taxableIra} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="5a. Pensions & Annuities" name="pensionAnnuities" value={formData.pensionAnnuities} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="5b. Taxable Amount" name="taxablePension" value={formData.taxablePension} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="6a. Social Security Benefits" name="socialSecurity" value={formData.socialSecurity} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="6b. Taxable Amount (SS)" name="taxableSocialSecurity" value={formData.taxableSocialSecurity} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="7. Capital Gain / (Loss)" name="capitalGainLoss" value={formData.capitalGainLoss} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="8. Other Income (Schedule 1)" name="otherIncome" value={formData.otherIncome} onChange={onChange} type="number" placeholder="0.00" />
      </FieldGroup>

      <FieldGroup title="Adjusted Gross Income & Deductions">
        <FormField label="11. Adjusted Gross Income" name="adjustedGrossIncome" value={formData.adjustedGrossIncome} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="12. Standard Deduction" name="standardDeduction" value={formData.standardDeduction} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="13. QBI Deduction (Sch. D)" name="qualifiedDeductible" value={formData.qualifiedDeductible} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="15. Taxable Income" name="taxableIncome" value={formData.taxableIncome} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="16. Tentative Tax" name="tentativeTax" value={formData.tentativeTax} onChange={onChange} type="number" placeholder="0.00" />
      </FieldGroup>

      <FieldGroup title="Credits">
        <FormField label="19. Child Tax Credit" name="childTaxCredit" value={formData.childTaxCredit} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="27. Earned Income Credit" name="earnedIncomeCredit" value={formData.earnedIncomeCredit} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="28. Additional Child Credit" name="additionalChildTaxCredit" value={formData.additionalChildTaxCredit} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="29. Amer. Opportunity Cr." name="americanOpportunityCredit" value={formData.americanOpportunityCredit} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="31. Other Credits" name="otherCredits" value={formData.otherCredits} onChange={onChange} type="number" placeholder="0.00" />
      </FieldGroup>

      <FieldGroup title="Other Taxes">
        <FormField label="17. Self-Employment Tax" name="selfEmploymentTax" value={formData.selfEmploymentTax} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="Unreported SS/Med. Tax" name="unreportedSSTax" value={formData.unreportedSSTax} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="Additional Medicare Tax" name="additionalMedicare" value={formData.additionalMedicare} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="Net Investment Income Tax" name="netInvestmentTax" value={formData.netInvestmentTax} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="Other Taxes (Sch. 2)" name="otherTaxes" value={formData.otherTaxes} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="24. Total Tax" name="totalTax" value={formData.totalTax} onChange={onChange} type="number" placeholder="0.00" />
      </FieldGroup>

      <FieldGroup title="Payments & Refund">
        <FormField label="25. Federal Tax Withheld" name="federalWithheld" value={formData.federalWithheld} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="26. Estimated Tax Pmts" name="estimatedTaxPayments" value={formData.estimatedTaxPayments} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="Refundable Credits" name="refundableCredits" value={formData.refundableCredits} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="37. Amount You Owe" name="amountOwed" value={formData.amountOwed} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="35a. Refund" name="refund" value={formData.refund} onChange={onChange} type="number" placeholder="0.00" />
        <FormField label="Routing Number" name="routingNumber" value={formData.routingNumber} onChange={onChange} />
        <FormField label="Account Number" name="accountNumber" value={formData.accountNumber} onChange={onChange} span={2} />
      </FieldGroup>

      {/* Sign / disclaimer bar */}
      <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-3 text-xs text-yellow-900">
        <strong>Under penalties of perjury</strong>, I declare that I have examined this return and
        accompanying schedules and statements, and to the best of my knowledge and belief, they are
        true, correct, and complete. Declaration of preparer (other than taxpayer) is based on all
        information of which preparer has any knowledge. <strong>§ 6064.</strong>
      </div>
    </div>
  );
}

// ── Main Shell ────────────────────────────────────────────────────────────────
export default function DynamicShell() {
  const { loadScore, isFrustrated, resetLoad, simulateHighFriction } =
    useCognitiveLoad(70);

  const [formData,     setFormData]     = useState(INITIAL_FORM);
  const [morphedCode,  setMorphedCode]  = useState(null);
  const [fallbackMsg,  setFallbackMsg]  = useState(null);
  const [socketStatus, setSocketStatus] = useState("disconnected");
  const [alertHistory, setAlertHistory] = useState([]);

  const socketRef    = useRef(null);
  const alertSentRef = useRef(false); // debounce: one alert per frustration burst

  // ── Socket connection ──────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
      timeout: 5000,
    });
    socketRef.current = socket;

    socket.on("connect",    () => setSocketStatus("connected"));
    socket.on("disconnect", () => setSocketStatus("disconnected"));
    socket.on("connect_error", () => setSocketStatus("error"));

    socket.on("ui_morph", ({ code }) => {
      setMorphedCode(code);
      setFallbackMsg(null);
      alertSentRef.current = false;
    });

    socket.on("ui_fallback", ({ error }) => {
      setFallbackMsg(error || "Server could not generate a new UI.");
      alertSentRef.current = false;
    });

    return () => { socket.disconnect(); };
  }, []);

  // ── Emit friction alert when frustrated ───────────────────────────────────
  useEffect(() => {
    if (isFrustrated && !alertSentRef.current && socketRef.current?.connected) {
      alertSentRef.current = true;
      const payload = {
        score: loadScore,
        formFields: Object.keys(formData),
        currentState: formData,
      };
      socketRef.current.emit("friction_alert", payload);
      setAlertHistory((prev) => [
        { score: loadScore, ts: new Date().toLocaleTimeString() },
        ...prev.slice(0, 4),
      ]);
    }
    if (!isFrustrated) alertSentRef.current = false;
  }, [isFrustrated, loadScore, formData]);

  const handleFormChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleMorphUpdate = (partial) => {
    setFormData((prev) => ({ ...prev, ...partial }));
  };

  const handleReset = () => {
    setMorphedCode(null);
    setFallbackMsg(null);
    resetLoad();
    alertSentRef.current = false;
  };

  const mode = morphedCode ? "morphed" : "static";

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* Page title */}
        <div className="text-center space-y-1">
          <h1 className="text-3xl md:text-4xl font-black bg-gradient-to-r from-aura-300 to-purple-400 bg-clip-text text-transparent">
            AuraGen
          </h1>
          <p className="text-gray-400 text-sm">
            Self-Healing Generative UI via Cognitive Load Detection
          </p>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-6 items-start">

          {/* ── Left: form area ─────────────────────────────────────────── */}
          <div>
            <AnimatePresence mode="wait">
              {morphedCode ? (
                <motion.div
                  key="morphed"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } }}
                  exit={{ opacity: 0, y: -20, transition: { duration: 0.3 } }}
                  className="bg-white rounded-2xl shadow-2xl p-6"
                >
                  <div className="mb-4 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-aura-700/20 border border-aura-600 text-aura-300 text-xs font-bold">
                      🧠 AI-Generated Conversational UI
                    </span>
                    <button
                      onClick={handleReset}
                      className="ml-auto text-xs text-gray-500 hover:text-gray-300 transition underline"
                    >
                      ← Back to original form
                    </button>
                  </div>
                  <DynamicRenderer
                    code={morphedCode}
                    formData={formData}
                    onUpdate={handleMorphUpdate}
                    onReset={handleReset}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="static"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.4 } }}
                  exit={{ opacity: 0, y: -20, transition: { duration: 0.3 } }}
                  className="bg-white rounded-2xl shadow-2xl p-6"
                >
                  <TaxForm formData={formData} onChange={handleFormChange} />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Server fallback notice */}
            <AnimatePresence>
              {fallbackMsg && (
                <motion.div
                  key="fallback-notice"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-4 rounded-xl bg-red-950/60 border border-red-700 p-4 flex items-start gap-3"
                >
                  <span className="text-xl">⚠️</span>
                  <div>
                    <div className="text-red-300 font-semibold text-sm">
                      Server could not morph the UI
                    </div>
                    <div className="text-red-400 text-xs mt-1 font-mono">{fallbackMsg}</div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ── Right: HUD sidebar ───────────────────────────────────────── */}
          <div className="space-y-4">
            <TelemetryHUD
              score={loadScore}
              isFrustrated={isFrustrated}
              mode={mode}
              socketStatus={socketStatus}
              onSimulate={simulateHighFriction}
              onReset={handleReset}
            />

            {/* Alert history */}
            {alertHistory.length > 0 && (
              <div className="hud-panel space-y-2">
                <div className="text-xs font-bold uppercase tracking-widest text-gray-500">
                  Friction Alert Log
                </div>
                {alertHistory.map((a, i) => (
                  <div
                    key={i}
                    className="flex justify-between text-xs font-mono text-gray-400"
                  >
                    <span>🚨 Score {a.score}</span>
                    <span>{a.ts}</span>
                  </div>
                ))}
              </div>
            )}

            {/* How-to panel */}
            <div className="hud-panel space-y-3">
              <div className="text-xs font-bold uppercase tracking-widest text-gray-500">
                How to trigger a morph
              </div>
              <ol className="space-y-2 text-xs text-gray-400 list-decimal list-inside">
                <li>
                  Flail your mouse around rapidly to spike the velocity signal.
                </li>
                <li>
                  Hover over a field and stop — hesitation adds load after ~1.2 s.
                </li>
                <li>
                  Click the same spot 3× quickly to trigger a rage-click spike.
                </li>
                <li>
                  Or press <kbd className="bg-gray-700 px-1.5 py-0.5 rounded text-gray-300 font-mono">🔥 Simulate</kbd> for instant demo.
                </li>
                <li>
                  When score exceeds <strong className="text-amber-400">70</strong>, AuraGen emits{" "}
                  <code className="text-aura-300">friction_alert</code> to the server.
                </li>
                <li>
                  The server responds with <code className="text-aura-300">ui_morph</code> containing
                  generated JSX that replaces the form in real-time.
                </li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

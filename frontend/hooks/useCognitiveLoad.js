"use client";
/**
 * useCognitiveLoad.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks three real-time friction signals:
 *   1. Velocity spikes  — erratic / high-speed mouse movement
 *   2. Hesitation       — pointer pauses (> HESITATION_MS ms) over interactive fields
 *   3. Rage clicks      — ≥ RAGE_CLICK_COUNT clicks within RAGE_CLICK_WINDOW ms
 *
 * Combines them into a 0-100 `loadScore` and sets `isFrustrated` above threshold.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ── Tuneable constants ────────────────────────────────────────────────────────
const FRUSTRATION_THRESHOLD = 70;   // score that flips isFrustrated
const VELOCITY_WEIGHT       = 0.40; // contribution of velocity signal
const HESITATION_WEIGHT     = 0.30; // contribution of hesitation signal
const RAGE_WEIGHT           = 0.30; // contribution of rage-click signal

const VELOCITY_SPIKE_PX     = 18;   // px/ms threshold for a "spike"
const VELOCITY_WINDOW       = 60;   // last N move events to track
const VELOCITY_DECAY        = 0.92; // per-tick decay

const HESITATION_MS         = 1200; // ms of stillness that counts as hesitation
const HESITATION_DECAY      = 0.88;

const RAGE_CLICK_COUNT      = 3;    // clicks within RAGE_CLICK_WINDOW
const RAGE_CLICK_WINDOW     = 1200; // ms
const RAGE_DECAY            = 0.90;

const TICK_MS               = 200;  // score-update interval

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useCognitiveLoad(threshold = FRUSTRATION_THRESHOLD) {
  const [loadScore,    setLoadScore]    = useState(0);
  const [isFrustrated, setIsFrustrated] = useState(false);

  // Mutable signal accumulators (not React state — no re-render pressure)
  const velocityScore  = useRef(0);
  const hesitationScore = useRef(0);
  const rageScore      = useRef(0);

  // Raw tracking refs
  const lastPos        = useRef({ x: 0, y: 0, t: 0 });
  const moveHistory    = useRef([]); // array of { vx, vy, speed }
  const hesitationTimer = useRef(null);
  const clickTimes     = useRef([]);

  // ── Mouse move ──────────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e) => {
    const now = performance.now();
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    const dt = Math.max(now - lastPos.current.t, 1);
    const speed = Math.sqrt(dx * dx + dy * dy) / dt; // px / ms

    lastPos.current = { x: e.clientX, y: e.clientY, t: now };

    moveHistory.current.push(speed);
    if (moveHistory.current.length > VELOCITY_WINDOW) moveHistory.current.shift();

    const spikes = moveHistory.current.filter((s) => s > VELOCITY_SPIKE_PX).length;
    const spikeRatio = spikes / moveHistory.current.length;
    velocityScore.current = Math.min(100, velocityScore.current * 0.9 + spikeRatio * 100 * 0.1);

    // Reset hesitation on movement
    if (hesitationTimer.current) clearTimeout(hesitationTimer.current);
    hesitationTimer.current = setTimeout(() => {
      // Pointer has been still for HESITATION_MS
      hesitationScore.current = Math.min(100, hesitationScore.current + 20);
    }, HESITATION_MS);
  }, []);

  // ── Click / rage-click ───────────────────────────────────────────────────────
  const handleClick = useCallback(() => {
    const now = performance.now();
    clickTimes.current.push(now);
    // keep only recent clicks
    clickTimes.current = clickTimes.current.filter(
      (t) => now - t <= RAGE_CLICK_WINDOW
    );
    if (clickTimes.current.length >= RAGE_CLICK_COUNT) {
      rageScore.current = Math.min(100, rageScore.current + 35);
    }
  }, []);

  // ── Score computation tick ───────────────────────────────────────────────────
  useEffect(() => {
    const tick = setInterval(() => {
      // Decay signals every tick
      velocityScore.current   *= VELOCITY_DECAY;
      hesitationScore.current *= HESITATION_DECAY;
      rageScore.current       *= RAGE_DECAY;

      const composite =
        velocityScore.current  * VELOCITY_WEIGHT +
        hesitationScore.current * HESITATION_WEIGHT +
        rageScore.current      * RAGE_WEIGHT;

      const clamped = Math.min(100, Math.max(0, composite));
      setLoadScore(Math.round(clamped));
      setIsFrustrated(clamped >= threshold);
    }, TICK_MS);
    return () => clearInterval(tick);
  }, [threshold]);

  // ── Attach / detach global listeners ─────────────────────────────────────────
  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("click",     handleClick,     { passive: true });
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("click",     handleClick);
      if (hesitationTimer.current) clearTimeout(hesitationTimer.current);
    };
  }, [handleMouseMove, handleClick]);

  // ── Public API ───────────────────────────────────────────────────────────────
  const resetLoad = useCallback(() => {
    velocityScore.current   = 0;
    hesitationScore.current = 0;
    rageScore.current       = 0;
    clickTimes.current      = [];
    moveHistory.current     = [];
    setLoadScore(0);
    setIsFrustrated(false);
  }, []);

  /** Instantly injects high friction for demo / QA purposes */
  const simulateHighFriction = useCallback(() => {
    velocityScore.current   = 95;
    hesitationScore.current = 90;
    rageScore.current       = 95;
  }, []);

  return { loadScore, isFrustrated, resetLoad, simulateHighFriction };
}

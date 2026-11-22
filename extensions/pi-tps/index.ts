/**
 * pi-tps — Tokens-per-second tracker for pi
 *
 * Captures structured telemetry at every LLM turn (per-API-call).
 * Uses the Pi response duration to measure request TPS, records gaps in
 * stream delivery, and persists telemetry
 * as custom entries in the session JSONL for provider debugging.
 *
 * Originally from: https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/tps.ts
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

// ─── Event types (not exported from pi's public API) ────────────────────────
// These mirror the internal types in @earendil-works/pi-coding-agent's
// dist/core/extensions/types.d.ts. When pi starts exporting them, replace
// these local definitions with imports.

interface TurnStartEvent {
  type: 'turn_start';
  turnIndex: number;
  timestamp: number;
}

interface TurnEndEvent {
  type: 'turn_end';
  turnIndex: number;
  message: unknown;
  toolResults: unknown[];
}

interface MessageStartEvent {
  type: 'message_start';
  message: unknown;
}

interface MessageUpdateEvent {
  type: 'message_update';
  message: unknown;
}

interface MessageEndEvent {
  type: 'message_end';
  message: unknown;
}

interface SessionTreeEvent {
  type: 'session_tree';
  newLeafId: string | null;
  oldLeafId: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum gap between token updates to count as a stall (ms) */
const STALL_THRESHOLD_MS = 500;

/** Event name emitted by pi-neuralwatt-provider per turn with energy-billed cost data. */
const NEURALWATT_ENERGY_EVENT = 'neuralwatt:turn-energy';

// ─── Data types ─────────────────────────────────────────────────────────────

/** Structured telemetry persisted per turn in the session JSONL */
interface TurnTelemetry {
  model: { provider: string; modelId: string };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  timing: {
    ttftMs: number | null; // time from turn_start to the first assistant update
    totalMs: number; // wall clock: turn_start → turn_end
    generationMs: number; // span from message_start to message_end per message
    requestMs?: number | null; // Pi's durationMs summed for output-bearing messages
    streamMs: number | null; // span from the second to the last assistant update
    stallMs: number; // accumulated gaps >= STALL_THRESHOLD_MS
    stallCount: number; // how many discrete stall events
    messageCount: number; // assistant messages in this turn
  };
  tps: number | null; // output / (requestMs / 1000)
  isPrimaryBranch: boolean; // compatibility field; true for a native-duration measurement
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
  /**
   * Blended $/M-tokens rate shown in the notification banner: the per-turn
   * cost divided by (totalTokens / 1_000_000). Cost source is the Neuralwatt
   * billed cost when available (energy-based), otherwise the list-price
   * compute cost from `cost.total`. null when neither is usable or tokens
   * are zero. Purely derived — recomputed in composeDisplayString, not a
   * duplicate of the cost block.
   */
  rateUsdPerMTokens: number | null;
  timestamp: number;
}

/** In-memory state accumulated during one LLM turn */
interface TurnTiming {
  turnIndex: number;
  turnStartMs: number;
  lastUpdateMs: number;
  firstTokenMs: number | null;
  currentMessageStartMs: number | null;
  assistantMessages: AssistantMessage[];
  totalGenerationMs: number;
  // Inter-update TPS tracking: measures the streaming span between
  // the first and last non-TTFT message_update events.
  firstStreamUpdateMs: number | null; // timestamp of first non-TTFT update
  lastStreamUpdateMs: number; // timestamp of most recent non-TTFT update
  stallMs: number;
  stallCount: number;
  inStall: boolean;
  messageCount: number;
  turnStartTimestamp: number; // wall-clock ms at turn_start, for correlating session energy entries
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the blended $/M-tokens rate: costUsd / (totalTokens / 1_000_000).
 * The single calculation backing the banner's $/M-tokens field. Returns null
 * when the inputs can't produce a meaningful rate (zero/negative tokens,
 * non-finite or negative cost).
 */
function computeRateUsdPerM(costUsd: number | null, totalTokens: number): number | null {
  if (costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) return null;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  const rate = costUsd / (totalTokens / 1_000_000);
  if (!Number.isFinite(rate) || rate < 0) return null;
  return Math.round(rate * 100) / 100;
}

/**
 * Fallback: find a Neuralwatt energy entry that was persisted in this session
 * during the current turn. This covers the case where pi-neuralwatt-provider
 * loads before pi-tps, so the energy entry exists before our turn_end runs,
 * but the live event cache missed (e.g. malformed payload, event ordering, or
 * a race).
 *
 * Scans backward from the most recent entry and requires the entry timestamp
 * to be >= turnStartTimestamp so a previous turn's energy data is not reused.
 */
function findEnergyCostFromSession(
  ctx: ExtensionContext,
  turnStartTimestamp: number
): number | null {
  if (!ctx.sessionManager?.getEntries) return null;

  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'custom' || e.customType !== 'neuralwatt-energy') continue;

    const entryTimestamp = typeof e.timestamp === 'number' ? e.timestamp : 0;
    if (entryTimestamp < turnStartTimestamp) return null;

    const data = e.data as Record<string, unknown> | null | undefined;
    if (!data) continue;

    const costUsd = typeof data.cost_usd === 'number' ? data.cost_usd : null;
    if (costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0) return costUsd;
  }

  return null;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  if (msg.role !== 'assistant') return false;
  // Guard: ensure usage exists with required numeric fields before downstream access.
  if (typeof msg.usage !== 'object' || msg.usage === null) return false;
  const usage = msg.usage as Record<string, unknown>;
  if (typeof usage.input !== 'number' || typeof usage.output !== 'number') return false;
  return true;
}

/**
 * Format a number with human-readable scaling (K, M, B).
 * - Values < 1000: raw integer (e.g. 567 → "567")
 * - Values ≥ 1000: scaled with one decimal, dropping ".0" (e.g. 1234 → "1.2K", 2000 → "2K")
 * - Handles up to billions (e.g. 1_234_567_890 → "1.2B")
 */
function formatNumber(num: number): string {
  if (num < 1_000) return String(num);

  let value: number;
  let suffix: string;

  if (num >= 1_000_000_000) {
    value = num / 1_000_000_000;
    suffix = 'B';
  } else if (num >= 1_000_000) {
    value = num / 1_000_000;
    suffix = 'M';
  } else {
    value = num / 1_000;
    suffix = 'K';
  }

  // Drop trailing ".0" for clean display
  const formatted = value.toFixed(1);
  return formatted.endsWith('.0') ? `${value.toFixed(0)}${suffix}` : `${formatted}${suffix}`;
}

/**
 * Format duration in seconds to human-readable string.
 * Sub-minute values show 1 decimal (e.g. "2.3s" for TTFT precision).
 * Rules: no decimals, up to 2 units, includes years.
 * @internal Exported for testing only.
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const seconds = Math.round(totalSeconds);
  const units = [
    { label: 'y', seconds: 365 * 24 * 60 * 60 }, // 365 days
    { label: 'mo', seconds: 30 * 24 * 60 * 60 }, // 30 days
    { label: 'w', seconds: 7 * 24 * 60 * 60 },
    { label: 'd', seconds: 24 * 60 * 60 },
    { label: 'h', seconds: 60 * 60 },
    { label: 'm', seconds: 60 },
    { label: 's', seconds: 1 },
  ];

  const parts: { value: number; label: string }[] = [];
  let remaining = seconds;

  // First pass: extract all units with non-zero values
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (remaining >= unit.seconds) {
      const value = Math.floor(remaining / unit.seconds);
      parts.push({ value, label: unit.label });
      remaining %= unit.seconds;
    }
  }

  // If we only found one unit, add the next smaller unit as zero
  // Skip 'w' (weeks) when the primary unit is 'mo' (months) for better readability
  if (parts.length === 1) {
    const firstUnitIndex = units.findIndex((u) => u.label === parts[0].label);
    if (firstUnitIndex < units.length - 1) {
      let nextIndex = firstUnitIndex + 1;
      // Skip weeks when showing months, skip months+weeks when showing years —
      // go directly to days for a cleaner display
      if (parts[0].label === 'mo' && units[nextIndex].label === 'w') {
        nextIndex++;
      } else if (parts[0].label === 'y' && units[nextIndex].label === 'mo') {
        nextIndex += 2; // skip mo and w, land on d
      }
      if (nextIndex < units.length) {
        parts.push({ value: 0, label: units[nextIndex].label });
      }
    }
  }

  // Return up to 2 most significant units
  const top2 = parts.slice(0, 2);
  return top2.map((p) => `${p.value}${p.label}`).join(' ');
}

/**
 * Compose the human-readable display string from structured telemetry.
 */
function composeDisplayString(t: TurnTelemetry): string {
  const parts: string[] = [];
  parts.push(t.tps !== null ? `TPS ${t.tps.toFixed(1)} tok/s` : 'TPS —');
  if (t.timing.ttftMs !== null) {
    parts.push(`TTFT ${formatDuration(t.timing.ttftMs / 1000)}`);
  }
  if (t.timing.requestMs != null) {
    parts.push(`req ${formatDuration(t.timing.requestMs / 1000)}`);
  }
  parts.push(formatDuration(t.timing.totalMs / 1000));
  parts.push(`in ${formatNumber(t.tokens.input)}`);
  parts.push(`out ${formatNumber(t.tokens.output)}`);
  if (t.timing.stallMs > 0) {
    const stallStr = formatDuration(t.timing.stallMs / 1000);
    parts.push(`stall ${stallStr}×${t.timing.stallCount}`);
  }
  if (t.rateUsdPerMTokens != null) {
    parts.push(`$${t.rateUsdPerMTokens.toFixed(2)}/M`);
  }
  return parts.join(' · ');
}

/**
 * Build structured TurnTelemetry from accumulated turn timing.
 * Returns null if the turn had no meaningful LLM output.
 */
function buildTelemetry(
  timing: TurnTiming,
  turnEndMs: number,
  billedCost: number | null = null
): TurnTelemetry | null {
  let input = 0;
  let output = 0;
  let requestMs: number | null = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;
  let hasCost = false;
  let model: { provider: string; modelId: string } | null = null;

  for (const message of timing.assistantMessages) {
    input += message.usage.input || 0;
    const messageOutput = message.usage.output || 0;
    output += messageOutput;
    if (messageOutput > 0 && requestMs !== null) {
      const durationMs = 'durationMs' in message ? message.durationMs : undefined;
      requestMs =
        typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
          ? requestMs + durationMs
          : null;
    }
    cacheRead += message.usage.cacheRead || 0;
    cacheWrite += message.usage.cacheWrite || 0;
    totalTokens += message.usage.totalTokens || 0;
    if (message.usage.cost) {
      costInput += message.usage.cost.input || 0;
      costOutput += message.usage.cost.output || 0;
      costCacheRead += message.usage.cost.cacheRead || 0;
      costCacheWrite += message.usage.cost.cacheWrite || 0;
      costTotal += message.usage.cost.total || 0;
      hasCost = true;
    }
    if (!model && message.provider && message.model) {
      model = { provider: message.provider, modelId: message.model };
    }
  }

  if (output <= 0) return null;
  if (!model) return null;

  const totalMs = turnEndMs - timing.turnStartMs;

  const streamMs =
    timing.firstStreamUpdateMs !== null
      ? timing.lastStreamUpdateMs - timing.firstStreamUpdateMs
      : null;
  const tps = requestMs === null ? null : Math.round((output / (requestMs / 1000)) * 10) / 10;

  // Single blended $/M-tokens rate for the banner. Cost source: Neuralwatt's
  // billed cost when present (energy-based, what the user actually pays),
  // otherwise the list-price compute cost from message.usage.cost. Never both
  // — billedCost wins outright when present, so there's no double-counting.
  // Pi represents models without pricing with an all-zero cost block. Treat
  // that as unavailable rather than displaying a misleading $0.00/M rate. An
  // explicit billed cost remains valid even when it is zero.
  const listPriceCost = hasCost && Number.isFinite(costTotal) && costTotal > 0 ? costTotal : null;
  const effectiveCost = billedCost ?? listPriceCost;
  const rateUsdPerMTokens = computeRateUsdPerM(effectiveCost, totalTokens);

  return {
    model,
    tokens: { input, output, cacheRead, cacheWrite, total: totalTokens },
    timing: {
      ttftMs: timing.firstTokenMs === null ? null : timing.firstTokenMs - timing.turnStartMs,
      totalMs,
      generationMs: timing.totalGenerationMs,
      requestMs,
      streamMs,
      stallMs: timing.stallMs,
      stallCount: timing.stallCount,
      messageCount: timing.messageCount,
    },
    tps,
    isPrimaryBranch: tps !== null,
    cost:
      listPriceCost !== null
        ? {
            input: costInput,
            output: costOutput,
            cacheRead: costCacheRead,
            cacheWrite: costCacheWrite,
            total: costTotal,
          }
        : null,
    rateUsdPerMTokens,
    timestamp: Date.now(),
  };
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function tpsExtension(pi: ExtensionAPI) {
  // Current turn timing state
  let currentTiming: TurnTiming | null = null;

  // Cached session entries for argument completion (captured on session_start / session_tree)
  let cachedEntries: Array<{ type?: string; customType?: string; data?: unknown }> = [];

  // pi-neuralwatt-provider emits billed cost during its turn_end handler. Keep
  // an early event only for the active turn; a late event corrects only the
  // turn that was just committed. turnIndex resets to zero on every agent run,
  // so billed costs must never survive beyond either of those scopes.
  let pendingNeuralwattBilledCost: { turnIndex: number; costUsd: number } | null = null;

  let lastCommittedTurn: {
    turnIndex: number;
    telemetry: TurnTelemetry;
    billedApplied: boolean;
    ctx: ExtensionContext;
  } | null = null;

  // A turn can end before tools, retries or queued continuations finish. Only
  // final settlement marks the assistant response as done.
  pi.on('before_agent_start', () => {
    lastCommittedTurn = null;
  });
  pi.on('agent_settled', (event, ctx) => {
    if (event.aborted || !ctx.hasUI) return;
    const clock = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const done = `done ${clock}`;
    const message = lastCommittedTurn
      ? `${composeDisplayString(lastCommittedTurn.telemetry)} · ${done}`
      : done;
    ctx.ui.notify(message, 'info');
  });

  pi.events?.on(NEURALWATT_ENERGY_EVENT, (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    const turnIndex = typeof p.turnIndex === 'number' ? p.turnIndex : null;
    const costUsd = typeof p.costUsd === 'number' ? p.costUsd : null;
    if (turnIndex === null || costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) {
      return;
    }

    // Provider loaded before pi-tps: turn_end has not reached us yet.
    if (currentTiming) {
      if (currentTiming.turnIndex === turnIndex) {
        pendingNeuralwattBilledCost = { turnIndex, costUsd };
      }
      return;
    }

    // Provider loaded after pi-tps: correct the turn we just committed. Do not
    // cache this event; the same turnIndex can belong to the next agent run.
    const committed = lastCommittedTurn;
    if (!committed || committed.billedApplied || committed.turnIndex !== turnIndex) return;

    committed.billedApplied = true;
    const correctedRate = computeRateUsdPerM(costUsd, committed.telemetry.tokens.total);
    if (correctedRate === null || correctedRate === committed.telemetry.rateUsdPerMTokens) return;

    const corrected = { ...committed.telemetry, rateUsdPerMTokens: correctedRate };
    committed.telemetry = corrected;
    pi.appendEntry('tps', corrected);
    pi.events?.emit('tps:telemetry', corrected);
    cachedEntries.push({ type: 'custom', customType: 'tps' });
    if (committed.ctx.hasUI) {
      committed.ctx.ui.notify(composeDisplayString(corrected), 'info');
    }
  });

  // ── Rehydration ─────────────────────────────────────────────────────────

  /**
   * Restore the most recent TPS notification on resume.
   * Supports both structured (TurnTelemetry) and legacy ({ message, timestamp })
   * entries for backwards compatibility with older session files.
   * Deferred via setTimeout so it survives TUI clear+rebuild.
   */
  function restoreTPSNotification(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === 'custom' && entry.customType === 'tps') {
        const data = entry.data as Record<string, unknown> | null;
        if (!data) continue;
        // Structured format (current): has model field
        if (data.model) {
          const message = composeDisplayString(data as unknown as TurnTelemetry);
          setTimeout(() => {
            ctx.ui.notify(message, 'info');
          }, 0);
          break;
        }
        // Legacy format: { message: string, timestamp: number }
        if (typeof data.message === 'string') {
          setTimeout(() => {
            ctx.ui.notify(data.message as string, 'info');
          }, 0);
          break;
        }
      }
    }
  }

  // Restore notification on session start/resume — skip only brand-new sessions
  pi.on('session_start', (_event, ctx) => {
    cachedEntries = ctx.sessionManager.getEntries();
    restoreTPSNotification(ctx);
  });

  // Restore notification after /tree navigation (same session, different branch)
  pi.on('session_tree', (_event: SessionTreeEvent, ctx: ExtensionContext) => {
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    cachedEntries = ctx.sessionManager.getEntries();
    restoreTPSNotification(ctx);
  });

  // ── Turn timing ─────────────────────────────────────────────────────────

  // Track wall-clock latency from the beginning of the Pi turn.
  pi.on('turn_start', (_event: TurnStartEvent) => {
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    currentTiming = {
      turnIndex: _event.turnIndex,
      turnStartMs: performance.now(),
      turnStartTimestamp: typeof _event.timestamp === 'number' ? _event.timestamp : Date.now(),
      lastUpdateMs: performance.now(),
      firstTokenMs: null,
      currentMessageStartMs: null,
      assistantMessages: [],
      totalGenerationMs: 0,
      firstStreamUpdateMs: null,
      lastStreamUpdateMs: 0,
      stallMs: 0,
      stallCount: 0,
      inStall: false,
      messageCount: 0,
    };
  });

  // The assistant message starts when the provider emits its stream start.
  // Providers can emit that after the underlying request has begun.
  pi.on('message_start', (event: MessageStartEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // Capture the message event span for diagnostics.
    currentTiming.currentMessageStartMs = now;
    currentTiming.messageCount++;

    // Reset stall-tracking clock so tool-execution gaps between
    // messages don't get counted as inference stalls.
    currentTiming.lastUpdateMs = now;
    currentTiming.inStall = false;
  });

  // Track the time to the first assistant update and gaps in delivery.
  pi.on('message_update', (event: MessageUpdateEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // The initial wait is recorded separately from inter-update gaps.
    if (currentTiming.firstTokenMs === null) {
      currentTiming.firstTokenMs = now;
      currentTiming.lastUpdateMs = now;
      return;
    }

    // Track the span of updates after the first for diagnostics.
    if (currentTiming.firstStreamUpdateMs === null) {
      currentTiming.firstStreamUpdateMs = now;
    }
    currentTiming.lastStreamUpdateMs = now;

    const gap = now - currentTiming.lastUpdateMs;

    // Detect stall: gap exceeds threshold. The full gap counts as stall
    // time — the threshold is a detection gate, not a duration discount.
    if (gap >= STALL_THRESHOLD_MS) {
      if (!currentTiming.inStall) {
        currentTiming.stallCount++;
      }
      currentTiming.inStall = true;
      currentTiming.stallMs += gap;
    } else {
      currentTiming.inStall = false;
    }

    currentTiming.lastUpdateMs = now;
  });

  // Track when a message ends
  pi.on('message_end', (event: MessageEndEvent) => {
    if (!currentTiming) return;
    if (!isAssistantMessage(event.message)) return;

    const now = performance.now();

    // Record the duration between the message start and end events.
    if (currentTiming.currentMessageStartMs !== null) {
      const messageGenerationMs = now - currentTiming.currentMessageStartMs;
      currentTiming.totalGenerationMs += messageGenerationMs;
      currentTiming.currentMessageStartMs = null;
    }

    // Store this message to count its tokens later (only current turn's messages)
    currentTiming.assistantMessages.push(event.message);
    currentTiming.lastUpdateMs = now;
  });

  // ── Persist telemetry ───────────────────────────────────────────────────

  // Calculate, display, and persist telemetry at the end of each LLM turn.
  // The Neuralwatt listener stores an early billed cost only while this exact
  // turn is active, so the handoff remains synchronous and adds no latency.
  pi.on('turn_end', (event: TurnEndEvent, ctx: ExtensionContext) => {
    if (!currentTiming) return;

    const timing = currentTiming;
    currentTiming = null;

    const turnEndMs = performance.now();

    // Pick the effective cost for the blended $/M-tokens rate: Neuralwatt's
    // billed cost when present, otherwise the list-price compute cost from
    // message.usage.cost. The live event is the primary source; if it missed,
    // we read the persisted neuralwatt-energy session entry. Only if neither
    // energy source is available do we fall back to the compute rate.
    // Prefer the live energy event, fall back to the persisted energy entry,
    // and finally to the list-price compute cost.
    let billedCost =
      pendingNeuralwattBilledCost?.turnIndex === event.turnIndex
        ? pendingNeuralwattBilledCost.costUsd
        : null;
    pendingNeuralwattBilledCost = null;

    if (billedCost === null && timing.turnStartTimestamp) {
      billedCost = findEnergyCostFromSession(ctx, timing.turnStartTimestamp);
    }

    const telemetry = buildTelemetry(timing, turnEndMs, billedCost);
    if (!telemetry) return;

    // Record this turn so a late-arriving neuralwatt:turn-energy event
    // (provider loaded after us) can retroactively correct the rate. Billed
    // cost wins when present, so a turn already billed at commit time is
    // never re-corrected.
    lastCommittedTurn = {
      turnIndex: event.turnIndex,
      telemetry,
      billedApplied: billedCost !== null,
      ctx,
    };

    // Persist structured telemetry to session for export and rehydration
    pi.appendEntry('tps', telemetry);

    // Emit event so other extensions can react to new telemetry
    pi.events.emit('tps:telemetry', telemetry);

    // Show notification only when UI is available
    if (ctx.hasUI) {
      const message = composeDisplayString(telemetry);
      ctx.ui.notify(message, 'info');
    }

    // Keep argument completion cache in sync with new entries
    cachedEntries.push({ type: 'custom', customType: 'tps' });
  });

  // ── Export commands ─────────────────────────────────────────────────────

  pi.registerCommand('tps-export', {
    description:
      'Export telemetry + session structure (model changes, branch points) as JSONL (--full for all branches, filter by customType)',
    getArgumentCompletions: (argumentPrefix: string) => {
      // Offer --full flag
      if ('--full'.startsWith(argumentPrefix)) {
        return [{ value: '--full', label: '--full (all branches, not just current)' }];
      }
      // Collect all unique customType values from cached session entries
      const customTypes = new Set<string>();
      for (const entry of cachedEntries) {
        if (entry.type === 'custom' && entry.customType) {
          customTypes.add(entry.customType);
        }
      }
      return Array.from(customTypes)
        .filter((ct) => ct.startsWith(argumentPrefix))
        .map((ct) => ({ value: ct, label: ct }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // Default: current branch. --full: entire session.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const full = tokens.includes('--full');
      const filterType = tokens.filter((t) => t !== '--full').join(' ') || null;

      // Collect entries: custom entries (+ optional customType filter) + structural entries
      // Structural entries (model_change, branch_summary) are always included so the
      // exported parentId tree is fully resolvable and the web inspector can show
      // model switches and branch points.
      const entries = full ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
      const isStructural = (e: { type: string }) =>
        e.type === 'model_change' || e.type === 'branch_summary';

      const exportedEntries = entries.filter(
        (e) =>
          isStructural(e) || (e.type === 'custom' && (!filterType || e.customType === filterType))
      );

      if (exportedEntries.length === 0) {
        const scope = full ? 'all-entries' : 'current-branch';
        ctx.ui.notify(`No matching entries found in ${scope}`, 'warning');
        return;
      }

      // Re-chain parentIds so the exported entries form a valid tree.
      // Original parentIds often point to message entries (not in the export).
      // We walk up the full session tree until we find the nearest ancestor
      // that IS in the export, giving us a self-contained tree structure.
      const byId = new Map<string, (typeof entries)[number]>(entries.map((e) => [e.id, e]));
      const exportedIds = new Set(exportedEntries.map((e) => e.id));

      const rechainParentId = (entry: (typeof exportedEntries)[number]): string | null => {
        let current: string | null = entry.parentId;
        while (current) {
          if (exportedIds.has(current)) return current;
          const parent = byId.get(current);
          current = parent?.parentId ?? null;
        }
        return null;
      };

      const rechained = exportedEntries.map((e) => ({
        ...e,
        parentId: rechainParentId(e),
      }));

      // Write to tmp directory
      const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
      const dir = join(cacheBase, 'pi-telemetry');
      mkdirSync(dir, { recursive: true });

      const sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const scopeParts = [full ? 'full' : 'branch', filterType].filter(Boolean);
      const scope = scopeParts.join('-');
      const filename = `pi-telemetry-${scope}-${sessionId.slice(0, 8)}-${timestamp}.jsonl`;
      const filepath = join(dir, filename);

      const content = rechained.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filepath, content);

      const structuralCount = exportedEntries.filter((e) => isStructural(e)).length;
      const customCount = exportedEntries.length - structuralCount;
      const parts: string[] = [];
      if (customCount > 0) parts.push(`${customCount} telemetry`);
      if (structuralCount > 0) parts.push(`${structuralCount} structural`);
      const summary = parts.length > 0 ? parts.join(' + ') : `${exportedEntries.length} entries`;
      try {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${opener} ${JSON.stringify(dir)}`, { stdio: 'ignore' });
      } catch {
        // opener not available — ignore silently
      }

      ctx.ui.notify(`Exported ${summary} → ${filepath}`, 'info');
    },
  });

  // ── Session export command ─────────────────────────────────────────────────

  pi.registerCommand('session-export', {
    description:
      'Export full session JSONL (all entry types, current branch only; --full for all branches)',
    getArgumentCompletions: (argumentPrefix: string) => {
      if ('--full'.startsWith(argumentPrefix)) {
        return [{ value: '--full', label: '--full (all branches, not just current)' }];
      }
      return [];
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const full = args.trim().split(/\s+/).includes('--full');

      const entries = full ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();

      if (entries.length === 0) {
        const scope = full ? 'all-entries' : 'current-branch';
        ctx.ui.notify(`No entries found in ${scope}`, 'warning');
        return;
      }

      // Write to tmp directory
      const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
      const dir = join(cacheBase, 'pi-sessions');
      mkdirSync(dir, { recursive: true });

      const sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const scope = full ? 'full' : 'branch';
      const filename = `pi-session-${scope}-${sessionId.slice(0, 8)}-${timestamp}.jsonl`;
      const filepath = join(dir, filename);

      const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filepath, content);

      try {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${opener} ${JSON.stringify(dir)}`, { stdio: 'ignore' });
      } catch {
        // opener not available — ignore silently
      }

      ctx.ui.notify(`Exported ${entries.length} entries → ${filepath}`, 'info');
    },
  });
}

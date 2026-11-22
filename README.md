<div align="center">

# 📊 pi-tps

**Tokens-per-second tracker for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Model request throughput, TTFT, delivery gaps, and cost after each Pi turn._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

## Pi compatibility

Request TPS uses `AssistantMessage.durationMs`, which Pi 1.6.0 records on completed responses from its built-in streams. The banner displays `TPS —` when the runtime or provider supplies no usable duration.

---

_Fork of [monotykamary/pi-tps](https://github.com/monotykamary/pi-tps), originally from [badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/tps.ts)._

---

## Quick start

```bash
pi install npm:@firespoon/pi-tps
```

## What's included

|               |                                                                        |
| ------------- | ---------------------------------------------------------------------- |
| **Extension** | Tracks TPS, TTFT, stall time, token usage, and cost after each turn    |
| **Export**    | `/tps-export` command — dump telemetry as JSONL with session structure |

### Features

- **Request TPS** divides provider-reported output tokens by Pi's native request duration.
- **Stall diagnostics** report gaps in stream delivery, including gaps of at least 500 ms.
- **Multi-message turns** sum output tokens and their request durations.
- **Notification banner** shows TPS, TTFT, request time, total turn time, tokens, and stalls.
- **Completion notification**: After the assistant fully settles, the TPS notification includes `done` and the local completion time. Aborted runs do not show it.
- **Persisted notifications**: Restored on session resume and `/tree` navigation (structured + legacy backward compatible)
- **Export command**: Dump telemetry as JSONL with automatic tree re-chaining for web inspectors
- **Extensible**: Emits `tps:telemetry` events so other extensions can react to telemetry

## Install

```bash
pi install npm:@firespoon/pi-tps
```

If you already have the upstream extension installed, remove it with `pi remove npm:@monotykamary/pi-tps` before installing the fork.

Or install from GitHub:

```bash
pi install https://github.com/FireSpoonYZ/pi-tps
```

The published npm package is intentionally slim: only `extensions/pi-tps/index.ts`, `README.md`, and `LICENSE`. It has **no runtime `dependencies`** and does **not** ship `npm-shrinkwrap.json` / lockfiles, so installs do not pull the multi-hundred-MB developer toolchain into `~/.pi/agent/npm`.

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/pi-tps ~/.pi/agent/extensions/
```

Then `/reload` in pi.

</details>

---

## Output format

```
TPS 42.5 tok/s · TTFT 1.2s · req 28.2s · 29.7s · in 567 · out 1.2K · stall 4.3s×1 · $3.60/M
```

| Field   | Description                                                                              |
| ------- | ---------------------------------------------------------------------------------------- |
| `TPS`   | Output tokens per second over the model request duration |
| `TTFT`  | Time from turn start to the first assistant update |
| `req`   | Native model request duration, when available |
| `s`     | Total wall-clock time from turn start to turn end |
| `in`    | Input tokens (human-readable: K/M/B)                                                     |
| `out`   | Output tokens (human-readable: K/M/B)                                                    |
| `stall` | Accumulated stall time × stall count (shown only when stalls exist)                      |
| `$/M`   | Blended $/million-tokens rate for this turn (shown only when a cost source is available) |

When Pi supplies no positive request duration, the banner displays `TPS —`.

```
TPS — · TTFT 0.8s · 1.3s · in 291 · out 46 · $2.59/M
```

### $/M-tokens rate

The trailing `$/M` segment is a blended per-turn rate: `effectiveCost / (totalTokens / 1_000_000)`, shown to two decimals. Only one cost source contributes per turn (no double-counting):

- When [pi-neuralwatt-provider](https://github.com/monotykamary/pi-neuralwatt-provider) reports the **energy-billed cost** for the turn (what you're actually invoiced), that wins outright.
- Otherwise the **list-price compute cost** from `message.usage.cost.total` (derived from the model's pricing table via pi-ai) is used.
- When neither is available (no pricing, zero tokens), the segment is omitted.

The cross-extension handoff is event-based: pi-neuralwatt-provider emits `neuralwatt:turn-energy` with `{ costUsd, energyJoules, turnIndex }` in its own `turn_end`; pi-tps subscribes at load and stashes `costUsd` keyed by `turnIndex`. pi dispatches `turn_end` handlers sequentially, so if the neuralwatt provider was registered before pi-tps the value is already cached when pi-tps's `turn_end` runs; if not, pi-tps falls back to the list-price rate for that one turn (the neuralwatt widget still shows billing separately). No latency is added — pi-tps reads the cache synchronously, never awaits.

Human-readable scaling (for token counts):

- `< 1K`: raw integer (`567`)
- `≥ 1K`: one decimal, drops `.0` (`1.2K`, `2K`, `15.3K`)
- `≥ 1M`: same pattern (`1.5M`)
- `≥ 1B`: same pattern (`1.2B`)

Duration formatting:

- `< 60s`: one decimal (`2.3s`, `45.0s`)
- `≥ 60s`: up to two units with no decimals (`1m 30s`, `2h 15m`, `3d 12h`, `1w 3d`, `1mo 0d`, `1y 0d`)

---

## How it works

The extension reads the final assistant message's `usage.output` and `durationMs` and reports the result at `turn_end`.

```text
TPS = output tokens / (request duration in milliseconds / 1000)
```

The token count includes reasoning reported in `usage.output`. Pi measures `durationMs` from the creation of the provider's response stream until completion. This includes first-response wait, networking, and delivery gaps. Context hooks such as automatic Hindsight recall run before that stream starts, and local tools execute after the model response. For turns with multiple output-bearing assistant messages, the extension sums their tokens and request durations.

### Timing breakdown

| Phase | Measured by |
| --- | --- |
| **Request** | Pi's native `durationMs`, summed for output-bearing messages |
| **TTFT** | `turn_start` to the first assistant `message_update`. The first update can be a content-block marker. |
| **Message events** | `message_start` to `message_end`, summed across messages |
| **Stream span** | Second through last assistant `message_update` |
| **Total** | `turn_start` to `turn_end`, including any tool execution in the turn |

### Stall detection

A gap of at least 500 ms between assistant updates contributes its full duration to `stallMs`. Consecutive long gaps count as one stall. The extension resets the gap timer at each `message_start`. The request duration used for TPS includes these gaps.

---

## Rehydration

When you resume a session (or navigate branches with `/tree`), pi-tps restores the most recent TPS notification — so you can see your last turn's stats after a reload.

Supports both the current structured `TurnTelemetry` format and legacy `{ message, timestamp }` entries for backward compatibility with session files created by earlier versions.

---

## Export command

Dump telemetry as JSONL for inspection or analysis:

```bash
/tps-export             # current branch, all custom entries
/tps-export --full      # all branches in the session
/tps-export tps         # current branch, filter by customType "tps"
/tps-export tps --full  # all branches, filter by customType "tps"
```

Each exported file is written to `~/.cache/pi-telemetry/pi-telemetry-{scope}-{sessionId}-{timestamp}.jsonl`.

The exporter includes **structural entries** (model_change, branch_summary) alongside telemetry entries so the exported tree is fully resolvable — the web inspector can show model switches and branch points. Parent IDs are automatically re-chained to point to the nearest ancestor that's included in the export, producing a self-contained tree.

---

## Telemetry event

After each turn, pi-tps emits a `tps:telemetry` event on pi's shared event bus. Other extensions can listen to build custom widgets, dashboards, or cost trackers.

```typescript
pi.events.on('tps:telemetry', (data) => {
  // data matches the TurnTelemetry structure below
  console.log(data.tps, data.tokens, data.timing);
});
```

The event payload:

| Field                 | Type             | Description                                                                                                                                                           |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tps` | `number \| null` | Output tokens per second over the native request duration |
| `isPrimaryBranch` | `boolean` | Compatibility field. New entries set it to true when TPS uses native request timing. |
| `model.provider`      | `string`         | Provider name (e.g. `openai`)                                                                                                                                         |
| `model.modelId`       | `string`         | Model identifier (e.g. `gpt-4`)                                                                                                                                       |
| `tokens.input`        | `number`         | Input tokens (summed across all assistant messages)                                                                                                                   |
| `tokens.output`       | `number`         | Output tokens generated by the LLM                                                                                                                                    |
| `tokens.cacheRead`    | `number`         | Cache-read tokens (provider-dependent)                                                                                                                                |
| `tokens.cacheWrite`   | `number`         | Cache-write tokens (provider-dependent)                                                                                                                               |
| `tokens.total`        | `number`         | Total tokens (input + output + cache)                                                                                                                                 |
| `timing.ttftMs` | `number \| null` | Milliseconds from turn start to the first assistant update |
| `timing.totalMs` | `number` | Milliseconds from turn start to turn end |
| `timing.generationMs` | `number` | Sum of assistant message event spans in milliseconds |
| `timing.requestMs` | `number \| null` | Sum of native request durations. Earlier telemetry entries may omit the field. |
| `timing.streamMs` | `number \| null` | Milliseconds from the second to the last assistant update |
| `timing.stallMs` | `number` | Total time in long gaps between updates, in milliseconds |
| `timing.stallCount`   | `number`         | Number of discrete stall events                                                                                                                                       |
| `timing.messageCount` | `number`         | Assistant messages in this turn                                                                                                                                       |
| `cost.input`          | `number \| null` | Input token cost                                                                                                                                                      |
| `cost.output`         | `number \| null` | Output token cost                                                                                                                                                     |
| `cost.cacheRead`      | `number \| null` | Cache-read token cost                                                                                                                                                 |
| `cost.cacheWrite`     | `number \| null` | Cache-write token cost                                                                                                                                                |
| `cost.total`          | `number \| null` | Total cost for this turn                                                                                                                                              |
| `timestamp`           | `number`         | Unix timestamp (ms) when telemetry was computed                                                                                                                       |
| `rateUsdPerMTokens`   | `number \| null` | Blended $/M-tokens rate for this turn (Neuralwatt billed cost when available, else list-price compute cost). `null` when no cost source is usable or tokens are zero. |

When `cost` is unavailable (provider doesn't report it), the entire `cost` object is `null`.

---

## Testing

Dev tooling (vitest, typescript, hooks) stays in the git repo only — use `pnpm` for local development.

```bash
# Install dev dependencies (repo checkout only)
bun install

# Run tests
bun run test

# Run tests with coverage
bun run test:coverage

# Type check
bun run typecheck

# Verify published tarball contents (should be ~3 runtime files)
bun run pack:check
```

---

## License

MIT

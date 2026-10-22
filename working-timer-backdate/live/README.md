# Live Gateway proof: Working timer for externally started runs (PR #180866 / issue #133545)

## Environment
- OpenClaw branch build: `6c0068f1e8d` (ceckert/working-timer-backdate). Gateway runtime: built from this SHA for both phases (the PR changes only `ui/`).
- "Before" Control UI: built from merge base `8e1fafd407f` in a throwaway `git worktree` (`pnpm ui:build`) and served by the same Gateway through `gateway.controlUi.root`.
- "After" Control UI: `dist/control-ui` built from `6c0068f1e8d`.
- Served build proof (gateway log, `client connected ... build=`): before `2026.10.5-8e1fafd407fd-...`, after `2026.10.5-6c0068f1e8df-...`. The before page's `/assets/index-*.js` was `index-CgTk7SwU.js`, the after page's `index-BU_TLLgZ.js`. When the after Gateway started it rejected the stale before tab with "control ui build rejected ... reload required", which shows the served bundle changed.
- Node 24.22.1, macOS 27.0.1 arm64. Model provider: OpenAI (`openai/gpt-5.4-mini`, through the implicit Codex agent runtime). The API key came from the environment and was never written to config.
- Isolation: `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` all pointed under the worktree's `.local/live-home/`. Port 28789 on loopback only. Token auth with a throwaway token (redacted). `OPENCLAW_SKIP_CHANNELS=1`. The operator's Gateway on 18789 was not touched. Each phase started from a fresh state dir.
- Browser: Control UI in one tab at 1280x800, open on `agent:main:main` for the whole sequence. The pane was never reloaded or navigated during a sequence.

## Sequence (identical for both builds)
Every run was started externally with `openclaw gateway call sessions.send`. The exact commands are in `before/commands.txt` and `after/commands.txt`. Each takes `{"key":"agent:main:main","message":...,"idempotencyKey":"proof-<phase>-runN"}`.
1. Sequence 1: run 1 uses a tool (`sleep 6`) and completes. The pane sits idle for about 60-90 s. Run 2 uses a tool (`sleep 12`).
2. Sequence 2: run 3 starts a tool (`sleep 40`) and is aborted externally with `gateway call sessions.abort` after about 10 s, so its failed or interrupted tool card stays in the pane. The pane sits idle for about 60-70 s. Run 4 says a sentence, then runs a tool (`sleep 12`).

An in-page sampler recorded the Working row's elapsed label every 500 ms (`*/working-row-samples.txt`, UTC). It ran as read-only inspection through the browser devtools, with no app code changed.

## Wall-clock timings (UTC, from the gateway's canonical chat.history stamps; `*/history-stamps.md`)
| Build | Run | Run's first gateway message | Run ends | Idle before the run | UI label at admission | UI label at first tool event | Continuous until settle |
|---|---|---|---|---|---|---|---|
| before (8e1fafd) | run 2 | 18:46:25.069 | 18:46:42.188 | ~89 s | 1s | 3s (18:46:28.8) | yes (to about 17s) |
| before (8e1fafd) | run 4 | 18:48:50.449 | 18:49:08.767 | ~65 s (after an aborted run) | 1s | 5s (18:48:55.8) | yes, 17s |
| after (6c0068f) | run 2 | 18:52:54.076 | 18:53:11.907 | ~77 s | 1s | 5s (18:52:59.7) | yes, 17s |
| after (6c0068f) | run 4 | 18:54:54.734 | 18:55:13.312 | ~71 s (after an aborted run) | 1s | 5s (18:55:00.7) | yes, 17s |

(Before run 1's user message carried no runId in history, so its "first message" in `before/history-stamps.md` is the first assistant message. The CLI `sessions.send` admission times are in `*/timings.txt`.)

## Result
- **After (branch):** each externally started run's Working row counts from that run's own start. It reads 1s in its own row at admission and increases 1 s per second with no jump when the run's tool events and identity arrive. It settles at about 17 s, which matches the gateway's per-run span of 17.8 and 18.6 s.
- **Before (merge base):** **the original defect did not reproduce on this live path.** Run 2 and run 4 also started at 1s in their own rows, including after an aborted run left a failed tool card behind. The gateway's history shows why: the user turn written by `sessions.send` carries the run's `runId`, and the pane receives it in the same moment as the active session row. So the Control UI holds an explicit run identity from admission, and the anonymous-identity window that the PR changes never opens in this sequence.
- What this proves: on a real Gateway with a real agent and real tool calls, the branch build keeps the correct per-run timer in the original issue's `sessions.send` shape, with no regression against the merge base. It does **not** show a live before/after difference. The defect's anonymous-admission window, where the session row is active but no runId is known yet, was only reached in the mocked-Gateway replay already in the PR (`../chat-external-run-timer.e2e.test.ts`). The issue's original observation (CUA runs on `0e8b476fc34`) may depend on a run shape (computer-use tool streams, or a different admission path) that this environment did not exercise.

## Files
- `before/`, `after/`: `commands.txt` (exact CLI calls), `timings.txt` (local time, UTC-7; CLI send, return and abort stamps), `history-stamps.md`, `working-row-samples.txt`, `gateway-log-excerpt.txt` (redacted), and screenshots:
  - before: `01-run1-finished.jpg`, `02-seq1-run2-after-first-tool-3s.jpg`, `03-seq2-run3-aborted-retained-failed-tool.jpg`, `04-seq2-run4-admitted-1s.jpg`
  - after: `01-run1-finished.jpg`, `02-seq1-run2-admitted-1s.jpg`, `03-seq1-run2-after-first-tool-6s.jpg`, `04-seq2-run3-aborted.jpg`, `05-seq2-run4-admitted-1s.jpg`
- No screen recording was made. The screenshots plus the 500 ms sampler log cover the continuity claim.

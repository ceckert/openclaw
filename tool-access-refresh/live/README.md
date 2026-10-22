# Live Gateway proof: Tool access refreshes when the run settles (PR #180865)

## Environment
- Branch `ceckert/tool-access-refresh` at `67cfcc45a6e`. The Gateway runtime was built from this SHA for every phase.
- "Before" Control UI: merge base `f113dde017e` (origin/main), built in a throwaway `git worktree` with `pnpm ui:build` and served by the same Gateway through `gateway.controlUi.root`. Served `index-DILO9yY0.js`; the page identity menu reads `git@f113dde`; the gateway logs client `build=2026.10.5-f113dde017ec-...`.
- "After" Control UI: built from `67cfcc45a6e`. Served `index-DZDz0EBy.js`; the identity menu reads `@67cfcc4`; the gateway logs `build=2026.10.5-67cfcc45a6eb-...`.
- Node 24.22.1, macOS 27.0.1 arm64. Model provider: OpenAI (`openai/gpt-5.4-mini`). The key came only from the environment.
- MCP server: the official `@modelcontextprotocol/server-filesystem@2.0.0`, installed into `.local/mcp` and run over stdio against an otherwise empty temp root holding one file, `hello.txt`. It was added through the Control UI (+ → Plugins → Add MCP server…, Availability **This session**, Transport Stdio). The menu label in this build is "Plugins", not "Connectors".
- Isolation: `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` all pointed under `.local/live-home`. Port 29789 on loopback only. Throwaway token auth (redacted). `OPENCLAW_SKIP_CHANNELS=1`. Each phase started from a fresh state dir. The operator's Gateway (18789) was not touched.
- The prompt was always sent externally: `openclaw gateway call sessions.send --json --params '{"key":"agent:main:main","message":"Use the fs-proof MCP server tools to list the allowed directories, then read hello.txt there, and reply with its contents only.","idempotencyKey":"<runId>"}'`. Sending it this way kept the Tool access panel open in the browser. Every call is listed in `*/commands.txt`.

## Primary capture: OpenClaw embedded runtime (`core-runtime/`)
`agents.defaults.models["openai/gpt-5.4-mini"].agentRuntime.id = "openclaw"`. A headless Chromium (Playwright, `tool-access-proof.driver.mjs`) drove the real Control UI against the real Gateway. It added the server, opened Tool access, started the run, and sampled the open panel's text every 500 ms. It also recorded video (`video/recording.webm`).

| | Before (f113dde) | After (67cfcc4) |
|---|---|---|
| Panel at open, before the run | Discovery notice: "MCP servers "fs-proof" are configured but not connected for this session yet. MCP tools will appear here after an agent run discovers them." | Same notice |
| Real MCP calls in the run (chat.history) | `fs-proof__list_allowed_directories`, `fs-proof__read_text_file` | same |
| Run settled (last message) | 19:09:26.794Z | 19:11:24.525Z |
| Panel after settle | **Still the notice** after 34 s more; 110 samples, panel never hidden | **"14 of 14 tools on" with per-tool toggles** at 19:11:26.871Z; 96 samples, panel never hidden |
| Gateway truth after settle | `tools.effective` lists all 14 `fs-proof__*` tools with no notice (`before/core-runtime/tools-effective-after-settle.json`) | n/a (the UI shows them) |

Screenshots in each `core-runtime/`: `00-add-mcp-server-dialog`, `01-tool-access-open-before-run`, `02-run-in-progress-panel-open`, `03-after-settle-panel-still-open`, `04-35s-after-settle-panel-still-open`. `driver-log.txt` holds the timestamped panel transitions. "hidden=0" means the panel was never closed or reopened.

## Supplementary capture: implicit Codex runtime (`codex-runtime/`)
This used the default `codex` harness and was driven through the Claude desktop browser pane. Here the pre-run panel shows "No tools available for this MCP server." rather than the discovery notice, because the Codex harness supplies an MCP catalog that is empty before the run.
- Before: the run used the server successfully (it returned the contents of hello.txt). The open panel stayed on "No tools available…" 33 s after settle (`02`, `03`), while the gateway's `tools.effective` already listed all 14 tools. As a control, Back → Tool access (the reopen refetch from #168668) then listed them (`04`).
- After: the same run with the panel left open. The 500 ms sampler (`panel-samples.txt`, 86 samples, never empty) shows "No tools available…" until 19:05:59.7Z, then "Loading tools…", then "14 of 14 tools on" at 19:06:00.2Z. The run's last message was at 19:05:57.8Z, and the panel was never reopened.

## Not shown or caveats
- Screenshots `00-add-mcp-server-dialog` and the config copies show the local stdio command path (home directory replaced with `~` in text files, but not inside the images).
- Codex-runtime screenshots are 800x500 pane captures. Core-runtime screenshots are 1280x800 headless captures.
- `before/core-runtime/ui-build-stamp.txt` also lists a `67cfcc45` client build. That was a stale tab from the earlier after-phase, still open in the hidden desktop browser pane, reconnecting. The Playwright page under test reported `git@f113dde` (`driver-log.txt`).

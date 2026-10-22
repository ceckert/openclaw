# Live Gateway proof: context budget meter and picker budgets (PR #180870)

## Environment
- Branch `ceckert/context-budget-widget` at `f2526514792` (package 2026.10.5, based on main `8e1fafd407f`). The Gateway and Control UI were both built from this SHA (`pnpm ui:build`). Served `index-Cu6fG-V5.js`.
- Latest stable: `openclaw@2026.10.6` (`fe06181`), installed with `npm install -g openclaw@latest --prefix .local/stable`. npm skipped the package install scripts by default. Served `index-dR8aXVJW.js`.
- Node 24.22.1, macOS 27.0.1 arm64. Model provider: OpenAI. The two models used were `openai/gpt-5-nano` (catalog contextWindow 128k) and `openai/gpt-5.4-mini` (contextWindow 400k).
- Isolation: `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` all pointed under `.local/live-home`. Port 30789 on loopback only. Throwaway token (redacted). `OPENCLAW_SKIP_CHANNELS=1`. The operator's Gateway was not touched.
- Driver: headless Chromium (Playwright) against the real served Control UI (`context-budget-proof.mjs`, `meter-after-turn.mjs`). It records the Gateway WebSocket frames for `sessions.patch`, `sessions.changed` and `models.list` (`*/gateway-frames.jsonl`; rows filtered to the models in use). Videos were recorded but deleted because the New Session page shows the machine hostname. The hostname in the `05-*` screenshots is masked.
- Settings created on stable (`before/settings-before-upgrade.txt`, `config-stable-phase.json5`): `gateway.controlUi.environment = {label:"proof", color:"teal"}` (the teal stripe and "proof" pill appear in every screenshot), `agents.defaults.thinkingDefault = low`, `agents.defaults.model.primary = openai/gpt-5.4-mini`, `controlUi.communityInvite = false`, and session label "Budget proof".

Sequence in every phase: create `agent:main:main` → `sessions.patch` model `openai/gpt-5-nano` → one turn (`sessions.send`) on nano → open the Chat model picker (search "gpt-5") → select **GPT-5.4 Mini** in the picker, with no reload → sample the meter → open New Session (`/new?agent=main`) and its model picker.

## (c) Latest-stable upgrade with settings retained: partly blocked
- Stable 2026.10.6 created the state: sessions, the label and the config settings (`before/sessions-list-before-upgrade.txt`).
- Starting the branch Gateway on that same state dir **refused to start**: "OpenClaw agent database ... uses schema version 25; stop active agents and run openclaw doctor --fix to migrate session identities" (`upgrade-attempt-branch-on-stable-state.log.txt`). Main's agent-DB schema moved past what 2026.10.6 writes, so any stable-to-branch upgrade needs `openclaw doctor --fix`.
- **I did not run `doctor --fix`.** Doctor's Gateway-service repair path can inspect and restart the account's launchd Gateway service (`src/commands/doctor-gateway-daemon-flow.ts`). I could not prove it would leave the operator's running Gateway alone, so I stopped there rather than risk it. The untouched stable-created state is kept at `.local/live-home/state-stable` for an operator-approved `doctor --fix` run.
- What was shown instead: the branch Gateway started with the **same config file** on a fresh state dir. Every config setting survived (`after/settings-after-switch-to-branch.txt`), and the environment stripe and pill are visible in the after screenshots. Session state did not carry over, because it required the doctor migration. The session (including the "Budget proof" label) was recreated with the same calls.

## (a) Model switch: meter and `sessions.changed`
Under the OpenClaw runtime (stable's implicit runtime; on the branch pinned through `agents.defaults.models[...].agentRuntime.id = "openclaw"`, see `config-branch-openclaw-runtime-phase.json5`):
| | Stable 2026.10.6 (`before/`) | Branch (`after/`) |
|---|---|---|
| Meter on nano after a turn | `19k of 108k (18%)` | `22k of 108k (20%)` |
| Immediately after picking GPT-5.4 Mini | `19k of 108k` | `22k of 108k` |
| about 0.5 s later, no reload | `19k of 400k (5%)` | `22k of 400k (5%)` |
| After one turn on GPT-5.4 Mini | n/a | `23.5k of 380k (6%)` (`after/meter-after-turn-log.txt`) |

So in this real sequence **stable already updates the meter to the new model's budget**. The original #165421 symptom (meter stuck on the old model's 108k prompt budget until reload) did not reproduce on 2026.10.6. The branch behaves the same and also updates after the next turn.

`sessions.changed` on the switch:
- Stable: `{"reason":"patch","model":"gpt-5.4-mini",...,"contextBudgetStatus":null}`, with no `contextTokens` key.
- Branch, Codex runtime (`after-codex-runtime/gateway-frames.jsonl`, 19:25:57.792Z): `{"reason":"patch","contextTokens":null,"contextBudgetStatus":null}`. **This is the new `contextTokens: null` clearing receipt.** After it the meter is **not rendered** until the next turn, which then shows `28.1k of 258.4k`. Under Codex both models report the runtime's 258.4k budget.
- Branch, OpenClaw runtime: the switch frame carried `contextBudgetStatus:null` and no `contextTokens` key. The meter moved from 108k to 400k as above.

## (b) Picker budgets: `<active> active · <max> max`
`models.list` on the branch now carries `contextTokens` on ordinary rows where the catalog has one, for example `{"id":"gpt-5.5","contextWindow":1050000,"contextTokens":272000}` (`after-codex-runtime/gateway-frames.jsonl`, `models.list` response). Rows without a catalog budget (gpt-5-nano, gpt-5.4-mini) have none; there the picker keeps showing only the maximum. The two models used for the meter therefore have no separate active budget. The row that shows the new format is GPT-5.5.
| Picker | Stable 2026.10.6 | Branch |
|---|---|---|
| Chat picker, GPT-5.5 row | `GPT-5.5 1M · OpenClaw` (`before/02-chat-model-picker.png`) | `GPT-5.5 272k active · 1M max · Codex` (`after-codex-runtime/02-chat-model-picker.png`) |
| New Session picker, GPT-5.5 row (no session metadata) | `1M` style only (`before/05-new-session-model-picker.png`) | `GPT-5.5 272k active · 1M max` (`after-codex-runtime/05-new-session-model-picker.png`) |
| Chat picker, selected session's own row | `gpt-5-nano 128k · OpenClaw` | `gpt-5-nano 258.4k active · 128k max · Codex` (see below) |

In the branch OpenClaw-runtime phase, the `agents.defaults.models` entries narrowed the picker to the two configured models, so GPT-5.5 is absent from `after/02` and `after/05`. The (b) evidence is therefore in `after-codex-runtime/`.

## Observations worth a look
1. Under the Codex runtime the selected session's row reads **`258.4k active · 128k max`** for gpt-5-nano: the active budget is larger than the model's maximum. The session-precedence path takes the session's Codex budget (258.4k) without capping it at the catalog window.
2. Under the Codex runtime, the `contextTokens: null` clear hides the meter until the next turn, rather than falling back to the new model's catalog budget as it does under the OpenClaw runtime. Whether that is intended is for the author to judge.
3. The live stable sequence did not reproduce #165421, so this proof shows no regression and the new wire behavior. It does not show the stale-meter bug being fixed.

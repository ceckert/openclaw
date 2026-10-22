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

---

## 2026-10-22 (second run): final head `abe4ab8927d`, corrected picker row, isolated stable upgrade

Both scenarios ran on `abe4ab8927d` (package `2026.10.6`, rebased on main). `pnpm build` and `pnpm ui:build` were rebuilt from that SHA. The served bundle changed from `index-Cu6fG-V5.js` (first run) to **`index-BfHEUWkV.js`**. Each driver log starts with a `served bundle:` line that it fetched from the running Gateway. `ui:build` printed a startup-JS gzip budget warning (309.1 KiB against a 309.0 KiB budget) and exited 0.

Every process used the isolated environment in `upgrade/isolated-env.sh`. It sets `HOME`, `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` under `.local/live-home`, plus `OPENCLAW_SKIP_CHANNELS=1`, `OPENCLAW_DISABLE_BONJOUR=1`, `OPENCLAW_SERVICE_REPAIR_POLICY=external` and `OPENCLAW_LAUNCHD_LABEL=ai.openclaw.proof-isolated-cbw`. The Gateway listened on loopback port 30789 with a throwaway token. Driver: `proof-driver-final.mjs` (headless Chromium; it masks the hostname and non-loopback IPs before every screenshot; no video). Each Gateway was stopped by the PID listening on 30789.

### Scenario A: corrected picker row on the final head (`after-final-head/`)
Setup: branch Gateway with the Codex runtime (`openclaw-codex.json5`, identical to `config-stable-phase.json5`) and a fresh state dir. The steps were `sessions.send` to create `agent:main:main`, `sessions.patch` to `openai/gpt-5-nano` with the label "Budget proof", then one turn on nano. After that turn, `sessions.list` showed `contextTokens: 258400` (`gateway-frames.jsonl`).
| | First run (`after-codex-runtime/`, `f2526514792`) | Final head (`after-final-head/`, `abe4ab8927d`) |
|---|---|---|
| Chat picker, selected nano row | `gpt-5-nano 258.4k active · 128k max · Codex` | **`gpt-5-nano 258.4k · Codex`** (`02-chat-model-picker.png`, `driver-log.txt`) |
| `models.list` nano row | `contextWindow: 128000` | `{"id":"gpt-5-nano","contextWindow":128000}` (unchanged catalog; `gateway-frames.jsonl`) |
| Meter on nano | `27.2k of 258.4k` | `27.3k of 258.4k (11%)` |
| Catalog-only rows, Chat picker | `GPT-5.5 272k active · 1M max · Codex` | same, plus the GPT-5.6 Sol/Terra/Luna and gpt-5.5-pro rows in the same format |
| New Session picker | `GPT-5.5 272k active · 1M max` | `GPT-5.5 272k active · 1M max`; `gpt-5-nano 128k`; `GPT-5.4 Mini Default 400k` (`05-new-session-model-picker.png`, hostname masked) |
The selected row now shows one budget, the session's 258.4k, with no "max". The catalog row keeps `contextWindow: 128000`. After the switch to GPT-5.4 Mini, the switch frame is again `{"reason":"patch","contextBudgetStatus":null}` and the meter is hidden until the next turn (`03-*`, as in the first run). `04-chat-model-picker-after-switch.png` shows the picker after the switch.

### Scenario B: isolated stable upgrade with existing sessions retained (`upgrade/`)

#### Migration path and source proof that it cannot touch launchd or `~/.openclaw`
The command was plain `openclaw doctor --fix --non-interactive` (branch build), run with the isolated environment. Doctor has no `--no-service` flag and no standalone migration subcommand. `--non-interactive` only suppresses prompts. The service paths are disabled by the install identity, not by a flag. In the source at `abe4ab8927d`:

1. **The install identity is non-default.** `src/config/paths.ts:104-117` (`isDefaultInstallIdentity`) returns false unless both the OS `HOME` and the effective `OPENCLAW_HOME` equal the account home (`os.userInfo().homedir`). It also returns false unless the state dir and config path are the canonical ones. Here all four point at `.local/live-home`.
2. **Every Doctor service-control entry checks that identity:**
   - The maintenance stop/restart (`src/commands/doctor-maintenance.ts:449-452`): `if (params.root && isDefaultInstallIdentity(env) && !externallyManaged && (await shouldManageGatewayService(env)))`. That block is the only place that calls `maybeStopManagedServiceBeforeMutableUpdate` and the only place that sets `stopped` (lines 570/574). Restoration returns early at line 159: `if (!before?.serviceEnv || !root) { return; }`. So Doctor stops nothing and restarts nothing.
   - The Gateway daemon repair (`src/flows/doctor-health-contribution-runners.gateway.ts:186-188` and `src/commands/doctor-gateway-daemon-flow.ts:228-231`): `if (!isDefaultInstallIdentity(process.env)) { note(NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON, "Gateway"); return; }`. This return comes before `resolveGatewayService()` and before `service.restart(...)` (line 271), so neither is reached.
   - Service config, node services and extra/dueling services (`doctor-health-contribution-runners.gateway.ts:49-54`): the runner returns while maintenance is active, and also when the identity is non-default.
   - Foreign launchd job removal (`src/commands/doctor-foreign-launchd-jobs.ts:60-66`): it skips removal when `!isDefaultInstallIdentity(env) || isServiceRepairDeferred(...)`. The listing before that gate is read-only, and it found nothing.
3. **Further layers, each one enough on its own:**
   - `OPENCLAW_SERVICE_REPAIR_POLICY=external` gives `resolveServiceRepairPolicy() === "external"`, so `isServiceRepairDeferred` is true (`src/commands/doctor-service-repair-policy.ts`).
   - Launchd paths come from `HOME`, not `OPENCLAW_HOME` (`src/daemon/paths.ts:9-15`, `src/daemon/launchd-service-files.ts:47-53`). The label comes from `OPENCLAW_LAUNCHD_LABEL` (`src/daemon/launchd-label.ts:13-17`). Even an unguarded path would therefore resolve `.local/live-home/Library/LaunchAgents/ai.openclaw.proof-isolated-cbw.plist`, which does not exist. The operator's job is `ai.openclaw.gateway`.
   - The legacy `~/.clawdbot` → `~/.openclaw` relocation is disabled whenever any explicit selector is set (`src/infra/state-migrations.state-dir.ts:189-195`).
4. **Runtime check of the same guards** under the exact environment (`upgrade/02-isolation-check.json`, produced by `isolation-check.mts`): `isDefaultInstallIdentity: false`, `serviceRepairPolicy: "external"`, `serviceRepairExternallyManaged: true`, the service-mutation guard returns "service management skipped: non-default state dir or config path", and `launchdPlistPath` is under `.local/live-home`.
5. **Observed:** `upgrade/operator-gateway-untouched.txt` holds three snapshots: before the migration, after doctor, and after the branch Gateway was stopped. Each was taken with a read-only `launchctl print gui/<uid>/ai.openclaw.gateway` plus `ps`. All three show `state = running`, the same `pid = 912`, `last exit code = (never exited)`, and the process start time `Tue Oct 20 15:49`.

Doctor followed the configured workspace (`.local/live-home/workspace`, the throwaway workspace). Its gh-auth diagnostic checked whether `~/.config/gh/hosts.yml` exists under the real home (`src/skills/lifecycle/gh-config-discovery.ts`, existence check only) and printed an advisory note. Nothing outside `.local/live-home` was written.

#### Steps
1. The stable DBs embed absolute paths under `.local/live-home/state/`, so the copy was placed at that path. The first run's OpenClaw-runtime state was renamed to `state-branch-oc`, and `cp -Rp state-stable state` made the copy. **`state-stable` is still pristine** (its files keep their 12:18 mtimes).
2. Stable `2026.10.6` (`.local/stable`) was started on the copy with the stable-phase config. `sessions-list-stable-as-found.txt` shows `agent:main:main` "Budget proof" on gpt-5.4-mini. Still on stable, a second session `agent:main:stable-second` ("Stable second", with one turn on gpt-5.4-mini) was added, and "Budget proof" was patched to gpt-5-nano with one turn on nano. Results: `sessions-list-before-upgrade-stable.txt`, `settings-before-upgrade-stable.txt`, and `stable-before/` (served `index-dR8aXVJW.js`, meter `21.7k of 108k`, picker rows in the `128k · OpenClaw` and `GPT-5.5 1M` styles). Stable was stopped, and the pre-migration state was snapshotted to `state-stable-pre-upgrade`.
3. Before doctor, the branch Gateway refused this state with the same "schema version 25 … run openclaw doctor --fix" error (`01-branch-start-before-doctor-refused.txt`, exit 78).
4. `openclaw doctor --fix --non-interactive` exited 0 (`03-doctor-fix-output.txt`, redacted). Key lines: it saved pre-migration SQLite backups; "Upgraded agent database schema … v25 -> v31"; heartbeats were migrated to Automations; the config write added only bookkeeping and plugin/skill entries (`wizard`, `meta`, `plugins.entries`, `skills.entries`, `agents.entries.main`, `messages.queue`); then "maintenance ready / finish / release" and "Doctor complete". It printed no Gateway service actions.
5. The branch Gateway was started on the migrated state and accepted it: the `database-readiness` and `schema-preflight` phases passed, the HTTP server listened and requests were served. There was no refusal line (`04-branch-gateway-startup-log-excerpt.txt`).

#### Results
| | Stable before upgrade | Branch after `doctor --fix` |
|---|---|---|
| `sessions.list` | `agent:main:main` `e602498a…` "Budget proof" gpt-5-nano; `agent:main:stable-second` `62825e12…` "Stable second" gpt-5.4-mini | **identical keys, sessionIds, labels, models and totalTokens** (`sessions-list-after-upgrade-branch.txt`) |
| Settings (`config.get`) | environment `{label:"proof",color:"teal"}`, `communityInvite false`, `thinkingDefault "low"`, primary `openai/gpt-5.4-mini` | identical (`settings-after-upgrade-branch.txt`); the teal environment stripe appears in the screenshots |
| Sidebar | "Stable second" listed; Budget proof transcript open (`stable-before/01`) | "Stable second" listed; the retained Budget proof transcript (OK / NANO / squid turns) open (`branch-after/01`, `02`) |
| Meter on retained nano session | `21.7k of 108k (20%)` | `21.7k of 108k (20%)` (`branch-after/01`) |
| Chat picker, selected nano row | `gpt-5-nano 128k · OpenClaw` | `gpt-5-nano 128k · OpenClaw` (one budget, no max; the retained session keeps its stable-era OpenClaw runtime) |
| Chat picker, catalog-only rows | `GPT-5.5 1M · OpenClaw` | `GPT-5.5 272k active · 1M max · OpenClaw` (`branch-after/02`) |
| New Session picker | `GPT-5.5 1M` | `GPT-5.5 272k active · 1M max` (`branch-after/05`) |
| Switch the retained session to GPT-5.4 Mini, no reload | n/a | The patch sends `{model:null, agentRuntime:null}`. Then `sessions.changed {"reason":"patch","contextTokens":null,"contextBudgetStatus":null}`; the meter clears from `108k` to not rendered (`branch-after/03`, `gateway-frames.jsonl`) |
| After one turn on GPT-5.4 Mini | n/a | meter `30.8k of 258.4k (12%)` (`branch-after/07`, `meter-after-turn-log.txt`); `sessions-list-after-switch-and-turn-branch.txt` shows the same sessionId with `contextTokens 258400` |

The switch clears the runtime pin (`agentRuntime:null`), so the retained session moves from the OpenClaw runtime to the default Codex runtime. That is why the meter is cleared, not moved to 400k, and why the next turn reports Codex's 258.4k window.

#### Not demonstrated
- Scenario B used `doctor --fix`, the documented upgrade migration. It did not use `openclaw update` (the installer path). An updater run would manage a real service, which this proof deliberately avoids.
- Screenshots show the operator's avatar and display name, as in the first run. They show no hostnames, IPs, tokens or keys.

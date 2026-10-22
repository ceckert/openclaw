# Live Gateway proof: dismissing retired pending inputs (PR #180871 / issue #134887)

## Result
On a real Gateway with a real agent (`openai/gpt-5.4-mini`, implicit Codex runtime) and the branch's served Control UI:

- **Retired rows were created the way the issue describes.** Follow-ups were admitted with `chat.send` while a tool run was working (`messages.queue.mode: "followup"`, so they queued). Two writers had their write role revoked while their follow-ups were queued, which left those rows `cancelled`. The Gateway was then SIGKILLed mid-run. While it was down, the `teammate` role lost write access to other people's sessions, so startup recovery refused to resume the teammates' inputs (`Chat input recovery blocked: Restart recovery operator source policy changed`) and they stayed `interrupted`. The owner's own queued follow-up was replayed normally.
- **Controls:** every retired row has **Dismiss** with a named label, and the footer has **Dismiss all** (`after/02-writer-rows-*.png`). The merge base shows the same rows with no control (`before/02-writer-rows-*.png`).
- **Dismiss one, then reload:** the row is gone and stays gone after a reload. In sqlite the row still exists, now `state: cancelled`, with `display: false` added to its message. Its content is intact. `chat.history` returns it as a content-less `display: false` row.
- **Dismiss all, then reload:** the page sends one `chat.pendingInputs.dismiss` call with exactly the four visible ids. All rows are kept as `cancelled` + `display:false`, and after the reload nothing is rendered and there is no footer.
- **Off-page copy:** browser B held an outbox copy of its accepted follow-up FB2 (unconfirmed, because its `chat.send` response never reached the page). B stayed offline while writer A dismissed FB2 in the UI. B then came back online and reloaded. B sent **no `chat.send` for FB2**, and its outbox copy was retired. The transcript gained no FB2 user turn, and the row stays cancelled/hidden. A control showed that B's outbox did drain on reconnect: B's never-accepted local copy FB3 was sent and became a user turn.
- **Refusals; each sqlite row is the same before and after:**
  - (a) read-only role: `FORBIDDEN missing scope: operator.write`.
  - (b) `operator.sessions.write` only, on a session it does not own: `FORBIDDEN` (`SESSION_ACCESS_CHANGED`). Session reads still work for this caller.
  - (c) queued input: `INVALID_REQUEST` with `details.code: PENDING_INPUT_NOT_RETIRED`. A mixed batch (queued + interrupted) is refused whole, and the interrupted row is untouched.
  - (e) view-only collaborator, (f) a writer whose role was revoked, (g) a teammate demoted while the Gateway was down: all `FORBIDDEN`.
  - (d) repeating an already-dismissed id returns it again in `dismissedIds`, with its `runId`. An unknown id goes to `missingIds`.
- **Dismissed rows survive a restart:** after another SIGKILL and restart they are still `cancelled` + `display:false`, nothing is resumed, and no user turns are added (`after/05-dismissed-survive-restart.txt`).
- **Merge base:** the owner gets `INVALID_REQUEST unknown method: chat.pendingInputs.dismiss`. A non-admin caller gets `FORBIDDEN missing scope: operator.admin`, which is how unknown methods are classified for non-admin callers.

### Finding: a view-only collaborator sees the controls
The PR body says callers who cannot mutate the session never see the controls. **That does not hold live for a view-only collaborator in a shared session.** `viewer@` has role `viewer` (`sessions.others: "view"`) and scopes `operator.read` + `operator.write`. Its UI renders Dismiss on every row plus Dismiss all (`after/04e-viewer-ui-*.png`). Clicking Dismiss all sends the request. The Gateway refuses it with `FORBIDDEN Session access changed; reopen the session before continuing.` The rows come back with that error in the footer, and sqlite is unchanged (`after/04e-viewer-ui-click-*.png`, `after/04e-viewer-ui-click-sqlite.txt`). The Gateway boundary holds. Only the presentation gate is too loose.

The session row the viewer receives is `{visibility: "shared", sharingRole: "viewer"}` (`after/rpc/04e-viewer-ui-session-row.txt`). The gate passes for two reasons:
- `readSessionMethodAccess(..., requiredScope: "operator.sessions.write")` passes, because the caller holds `operator.write`.
- The participation tracker blocks `sharingRole === "viewer"` only when visibility is not `shared`.

The same viewer also sees an enabled composer and model picker, so the looseness is not specific to this PR. Still, the PR's claim should either be narrowed or the gate should also deny `sharingRole === "viewer"`.

## Environment
- Branch `ceckert/pending-input-discard` at `f39609ddb4a`. Runtime from `pnpm build` and Control UI from `pnpm ui:build` (`dist/control-ui`, bundle `index-BMYjMSkL.js`).
- Merge base `a918e883b0e` in a throwaway worktree at `.local/before-wt` (detached). It has its own `pnpm build` and its own Control UI (bundle `index-CFb3miFU.js`), served with `gateway.controlUi.root`. The before Gateway ran from that worktree, so the method is genuinely absent.
- Node 24.22.1, macOS arm64. Headless Chromium (Playwright 1.64 from the worktree), 1280x800.
- Isolation:
  - `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` (`state-after` / `state-before`) and `OPENCLAW_CONFIG_PATH` all under `<worktree>/.local/live-home`.
  - `OPENCLAW_SKIP_CHANNELS=1`. Loopback bind, port 29871. Fresh state for each phase.
  - The operator Gateway on 18789 was not touched.
  - The OpenAI key came from the environment only.
- Auth: `gateway.auth.mode: "trusted-proxy"` with a throwaway local password (env SecretRef, redacted). `trustedProxies: [127.0.0.1, ::1]`, `trustedProxy: { userHeader: "x-proof-user", requiredHeaders: ["x-proof-proxy"], allowLoopback: true, deviceAutoApprove: { enabled: true, scopes: [operator.read, operator.write, operator.sessions.read, operator.sessions.write] } }`. `controlUi.allowedOrigins: ["http://127.0.0.1:29871"]`.
  - The owner is the local CLI (shared owner, password). It created and drove `agent:main:main`.
  - Teammates are trusted-proxy identities, `<name>@example.test`. Their requests come over loopback with the proxy headers and `x-forwarded-for: 203.0.113.x` (documentation range).
  - Each identity gets a durable profile on first connect. Roles are assigned with `users.setRole`.
- Roles (`gateway.roles`, default `viewer`):

  | Role | `sessions.others` | Scopes | Assigned to |
  |---|---|---|---|
  | `writer` | write | read+write | alice@ (writer A); also revoked@ and erin@ before they were revoked |
  | `teammate` | write; switched to `view` while the Gateway was down, then back | read+write | carol@, dave@, bee@ (browser B) |
  | `viewer` | view | read+write | viewer@; revoked@ and erin@ after revocation |
  | `readonly` | view | `operator.read` | readonly@ |
  | `sessionsonly` | write | `operator.sessions.read` + `operator.sessions.write` | sessionsonly@ |

## Scripts (`.local/live-bin/`, not committed)
- `oc` / `oc-before`: run `openclaw` with the isolated paths and password.
- `gw-start[-before]`, `gw-kill`: start the proof Gateway, and SIGKILL only the process tree listening on 29871.
- `rpc-as.mjs <email> <scopes> <method> <params> …`: a raw operator WebSocket client. It presents trusted-proxy identity headers and signs the v3 device payload with a persisted Ed25519 key per identity. It prints the raw `connect` result and each raw RPC response.
- `ui.mjs <profile> <outDir> <action>`: drives the served Control UI in a persistent Chromium profile. Actions:
  - `rows`: scroll the virtualized transcript bottom-to-top, record every `pending-input:<id>:state` row, its button label and the footer button, and screenshot each row.
  - `dismiss-id`: click one row's Dismiss, then reload.
  - `dismiss-all`: click the footer's Dismiss all, then reload.
  - `click-dismiss-all`: click Dismiss all as a caller expected to be refused.

  The page's outgoing `chat.send` / `chat.pendingInputs.dismiss` / `chat.abort` requests are logged from `WebSocket.prototype.send`.
- `offpage.mjs`: the off-page scenario.
- `step1.sh` / `step-before.sh`: create the retired rows.
- `rpc-denials.sh`: the refusal cases.
- `sq.mjs`: read-only dump of `session_pending_inputs` in `state-*/agents/main/agent/openclaw-agent.sqlite`. Per row it prints `state`, the stored message's `display`, content, a sha256 prefix and the byte length of `message_json`.
- `hist.sh`: `chat.history` excerpt with `pendingInputs` rows and user turns.

Two in-browser test harness manipulations were used. They affect only the browser and never what the Gateway receives:
1. For browser B's follow-ups, the page drops the `res` frame of its own `chat.send`, simulating a lost response. The request still reaches the Gateway and is admitted. The Control UI therefore keeps its outbox copy as unconfirmed (`sendState: waiting-reconnect`).
2. Browser B is taken offline by `context.routeWebSocket`. While "offline", new sockets are closed. While online, sockets are passed through to the Gateway unchanged with `connectToServer()`.

## Sequence and artifacts (`after/`)
1. **Create retired rows** (`01-create-retired.txt`: every command, raw responses, and sqlite before and after each step).
   - The owner starts `sleep 150` and queues F1. revoked@ and erin@ (writers) queue FR and FE. carol@ and dave@ (teammates) queue FC and FD over RPC. Browser B (bee@, teammate) queues FB from the composer.
   - `users.setRole` moves revoked@ and erin@ to viewer, and FR and FE become `cancelled`.
   - SIGKILL. The teammate role is changed to `others: view`. Restart.
   - FC, FD and FB are `interrupted` (recovery blocked). F1 is replayed and the main run resumes.
2. **Controls and dismissal in the UI** (writer alice@):
   - `02-writer-rows-<id>.png`: each of the 5 retired rows with Dismiss, plus `-bottom` with Dismiss all.
   - `02-dismiss-one-{1-row-before-click,2-after-click,3-after-reload}.png` and `ui-driver-alice.txt`: the page sends `chat.pendingInputs.dismiss {inputIds:[FC]}`. After the click and after the reload, 4 rows are rendered and FC's is not.
   - `02-sqlite-dismiss-one.txt`: FC goes from `interrupted` to `cancelled`, `message.display: false`, content still "Follow-up FC from teammate carol@".
   - `02-history-before.txt` and `02-history-after-dismiss-one.txt`: `chat.history` returns FC as `display:false` with empty content. No user turn is added.
   - `02-dismiss-all-*` (screenshots plus `02-sqlite-dismiss-all.txt` and `02-history-after-dismiss-all.txt`): one request with the four visible ids. 0 rows and no footer after the click and after the reload. All 6 rows are retained as `cancelled` + `display:false` with their content.
3. **Off-page copy** (`03-offpage-copy.txt`, `03-offpage-*.png`):
   - B (teammate, write) sends FB2 and FB3 during owner run 2. FB2 is accepted (`queued`), but B never sees the response, so B's outbox holds FB2 (`waiting-reconnect`, `sendRunId` = its run id). FB3 is held locally behind the active run (`waiting-idle`, never sent).
   - B goes offline. SIGKILL. Teammate becomes view. Restart. FB2 is now `interrupted` (recovery blocked).
   - A dismisses FB2 in the UI (`03-offpage-A-dismiss-FB2-*.png`). FB2 becomes `cancelled` + `display:false`.
   - Teammate gets write back (live reload). B comes back online. In the 30 s after reconnecting, **B's only `chat.send` is FB3**; the FB2 copy is retired and the outbox is empty.
   - B reloads: 25 s with **no `chat.send`**.
   - `chat.history`: user turns gain only "Follow-up FB3 …", never FB2. The FB2 row is still `cancelled` + `display:false`.
4. **Refusals** (`rpc/`; each file has the target row from sqlite before, the raw connect and RPC response, and the row after):
   - `04a-read-only-scope.txt` and `04a2-…requests-write.txt`: in 04a2 the role ceiling caps a requested `operator.write` to `operator.read`.
   - `04b-sessions-write-not-owner.txt`. `04b0-…` is the first attempt, whose device had been paired with `operator.read` only. Asking for the session scopes was a `scope-upgrade` that needed pairing approval. It was retried with a fresh device.
   - `04c-queued-input-refused.txt` (`PENDING_INPUT_NOT_RETIRED`), `04d-repeat-is-idempotent.txt`, `04e-view-only-role.txt`, `04f-revoked-writer.txt`, `04g-demoted-teammate.txt`.
   - The UI side for a view-only caller is in the Finding above.
5. `05-dismissed-survive-restart.txt`: SIGKILL plus restart after dismissal. The rows are unchanged and nothing resumes.
- `gateway-log-excerpt.txt` (redacted): connection auth modes, `Chat input recovery blocked`, `Pending input replay` outcomes, restart-recovery lines, and every refused `chat.pendingInputs.dismiss` response. The Gateway's ws log records refusals but not successful responses.

`before/`: the same recipe on the merge base:
- `01-create-retired.txt`: FR `cancelled` by role revocation, FC `interrupted` by SIGKILL plus the demoted teammate role.
- `02-writer-rows-*.png`: the rows with no Dismiss and no Dismiss all. `ui-driver-before-alice.txt` records `(no button)` and `"Dismiss all" footer buttons: 0`.
- `rpc/04-dismiss-unknown-method.txt`.

## Not demonstrated live, or caveats
- **Revocation between RPC admission and the worker commit** was not demonstrated live. `users.setRole` closes the connection immediately, so a single in-flight call cannot straddle a role change from outside. Live, the revoked writer reconnects and is refused before anything changes (04f, 04g). The commit-time rollback is covered by the store test ("revoking authority at the worker commit rolls the transaction back with no row changed") in `src/config/sessions/session-pending-input-dismissal.test.ts`. It is also covered by the registered-RPC test "revoking session write access between RPC admission and the worker commit returns FORBIDDEN with no row changed" in `src/gateway/server-methods/chat-pending-inputs-dismiss-handler.test.ts`.
- **Own-session success with `operator.sessions.write` only** (the positive side of the own-session gate) was not exercised live. Only the not-owner refusal was. The handler test covers the success case.
- **No undismissed control for the off-page case.** The off-page control (FB3) is a browser-only copy that the Gateway had never accepted. This run does not show what B would do with an accepted, interrupted, *undismissed* copy. It shows only that the dismissed one (FB2) was not resent while the same outbox did drain.
- **Why the rows were retired.** The cancelled rows here come from role revocation, not from `chat.abort`. An earlier exploratory run also showed `chat.abort` leaving visible `cancelled` rows. The interrupted rows are interrupted because recovery was refused by a changed role policy. A plain SIGKILL alone lets startup recovery resume the owner's queued inputs. That was seen in exploration and is visible for F1 here.
- **The agent ran shell commands in the isolated workspace during recovered turns.** It probed `ps`, `rg`, `openclaw --help` and similar, with the isolated `OPENCLAW_*` environment inherited. This is visible in some screenshots.
- **Redaction:**
  - Text artifacts have the home directory replaced with `~`, the operator's display name with `<owner>`, the local user name with `<user>`, and non-loopback IPs with `<ip>`. The throwaway password is not in any artifact.
  - Screenshots still show the owner profile's display name and avatar (from the OS account), plus the branch label in the sidebar.
  - Input ids, run ids, session ids and profile ids are random per run and were left in.
- Exploratory runs that did not reach a clean state (a session wedged by an interrupted non-owner turn, and a missing outbox because B's tab had closed) are kept outside the proof under `.local/explore-artifacts/` and are not part of this evidence.

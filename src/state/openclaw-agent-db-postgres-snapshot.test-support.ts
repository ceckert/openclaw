import { once } from "node:events";
import { MessagePort, parentPort, workerData } from "node:worker_threads";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import {
  installSqliteDatabaseAdmissions,
  withSqliteDatabaseAdmissionExchange,
} from "../infra/sqlite-database-admission.js";
import { exchangeSqliteDatabaseAdmissions } from "../infra/sqlite-worker-database-admission-relay.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "./openclaw-agent-db-readonly-scope.js";

if (parentPort) {
  const port = parentPort;
  const { admissions, selection, target } = workerData;
  installDatabaseEngineSelection(selection);
  installSqliteDatabaseAdmissions(admissions);
  const scope = new OpenClawAgentDatabaseReadOnlyScope();
  const [relay] = await once(port, "message");
  if (!(relay instanceof MessagePort)) {
    throw new TypeError("Expected a PostgreSQL admission relay port");
  }
  const read = () =>
    withSqliteDatabaseAdmissionExchange(
      (facts, location, create) => exchangeSqliteDatabaseAdmissions(relay, facts, location, create),
      () =>
        scope.run(target, () =>
          scope.read(
            ({ db }) =>
              db
                .prepare(
                  "SELECT count(*)::int AS messages FROM transcript_events WHERE session_id = ? AND message_role = 'user'",
                )
                .get(target.sessionId),
            target,
            { snapshot: true },
          ),
        ),
    );
  try {
    const next = once(port, "message");
    const first = read();
    port.postMessage(first.found ? first.value : first, []);
    await next;
    const second = read();
    port.postMessage(second.found ? second.value : second, []);
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) }, []);
  } finally {
    scope.close();
    relay.close();
    port.close();
  }
}

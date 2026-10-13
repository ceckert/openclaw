import type { AsyncLocalStorage } from "node:async_hooks";
import { threadId } from "node:worker_threads";
import type { SqliteDatabaseAdmissionExchange } from "./sqlite-database-admission-record.js";

export function createSqliteDatabaseAdmissionExchange(
  exchange: AsyncLocalStorage<SqliteDatabaseAdmissionExchange>,
) {
  return {
    withSqliteDatabaseAdmissionExchange<T>(
      this: void,
      exchangeOwner: SqliteDatabaseAdmissionExchange,
      operation: () => T,
    ): T {
      return exchange.run(exchangeOwner, operation);
    },
    captureSqliteDatabaseAdmissionExchangeScope(this: void) {
      const exchangeOwner = exchange.getStore();
      return <T>(operation: () => T): T =>
        exchangeOwner ? exchange.run(exchangeOwner, operation) : exchange.exit(operation);
    },
    canShareSqliteDatabaseAdmissions(this: void): boolean {
      return threadId === 0 || exchange.getStore() !== undefined;
    },
  };
}

import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { formatSqliteErrorCodeSuffix } from "./sqlite-error-diagnostics.js";

export const SCHEMA_RECOVERY =
  'Stop the Gateway, preserve the database and its SQLite sidecars, resolve the reported cause, then rerun "openclaw doctor --fix" against the same state/config.';

/** Keep the cause before the location: support redaction consumes a pathname's suffix. */
export function formatSchemaMigrationFailure(
  summary: string,
  pathname: string,
  error: unknown,
): string {
  const reason = String(error)
    .replace(`SQLite schema is incomplete or noncanonical for ${pathname}: `, "")
    .replaceAll(pathname, "[redacted-path]")
    .replace(/; run openclaw doctor --fix to repair it\.$/u, ".");
  const sentence = /[.!?]$/u.test(reason) ? reason : `${reason}.`;
  return `${summary}${formatSqliteErrorCodeSuffix(error)}: ${sentence} Database: ${pathname}`;
}

export function formatStateSchemaMigrationFailure(
  pathname: string,
  error: unknown,
  automatic: boolean,
): string {
  // Reaching this catch inside doctor means repair itself refused or failed,
  // so the runtime asserts' "run openclaw doctor --fix" advice is circular here.
  const warning = formatSchemaMigrationFailure(
    "Failed migrating shared state database schema",
    pathname,
    error,
  );
  const reason = automatic
    ? warning
    : warning.replace(
        /has a legacy ([a-z ]+) schema; run openclaw doctor --fix to migrate it\.?/u,
        "has a legacy $1 schema; automatic repair refused the unrecognized schema shape.",
      );
  // Keep the existing fixed public classification separate from local cause details.
  const diagnostic =
    extractErrorCode(error) === "CLIENT_CREDENTIAL_SOCKET_INVALID"
      ? "Client credential socket material is invalid.\n"
      : "";
  return `${diagnostic}${reason}`;
}

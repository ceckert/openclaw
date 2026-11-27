import { expect, it } from "vitest";
import { formatConfigReloadFailure } from "./config-reload-candidates.js";

it("logs a reload failure with its stack frames and cause after the established first line", () => {
  const cause = new Error("database path is a directory");
  const error = new Error("reload apply failed", { cause });

  const [headline, ...detail] = formatConfigReloadFailure(error).split("\n");

  expect(headline).toBe("config reload failed: Error: reload apply failed");
  expect(detail[0]).toMatch(/^\s+at /u);
  expect(detail).toContainEqual(
    expect.stringMatching(/^Caused by: Error: database path is a directory$/u),
  );
});

it("keeps a thrown non-error value on one line", () => {
  expect(formatConfigReloadFailure("plain failure")).toBe("config reload failed: plain failure");
});

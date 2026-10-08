import { afterAll } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";

export type Fixture = Awaited<ReturnType<typeof createFixture>>;
let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;

afterAll(async () => {
  await state?.cleanup();
});

export async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  state ??= await createOpenClawTestState({ scenario: "minimal" });
  state.applyEnv();
  const work = new AsyncWorkScope();
  let fixture: Fixture | undefined;
  try {
    await work.track(async () => {
      fixture = await createFixture("operator.read", false, {
        worktree: { id: "facts-worktree", branch: "change", repoRoot: "/synthetic/repository" },
        label: "Review the change",
        lifecycleRevision: "current-generation",
        status: "done",
        lastActivityAt: 1,
        observerDigest: {
          sessionKey,
          headline: "Ready for review",
          assessment: "The change is complete and awaits review.",
          health: "done",
          revision: 3,
          updatedAt: 10,
        },
      });
      const methodRegistry = createRequestGatewayMethodRegistry();
      fixture.context.getGatewayMethodRegistry = () => methodRegistry;
      try {
        await run(fixture);
      } finally {
        await fixture.close();
      }
    });
  } finally {
    try {
      await work.drain();
    } finally {
      await fixture?.removeSessions();
    }
  }
}

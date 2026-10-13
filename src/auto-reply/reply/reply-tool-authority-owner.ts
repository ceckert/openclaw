import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const operatorAuthorityIdentities = resolveGlobalSingleton(
  Symbol.for("openclaw.replyOperatorAuthorityIdentities"),
  () => ({ keys: new WeakMap<object, number>(), nextId: 1 }),
);

export function resolveReplyOperatorAuthorityKey(
  authority: AdmittedRunOperatorAuthority | undefined,
): string {
  if (!authority) {
    return "";
  }
  const source = authority.source ?? authority;
  let identity = operatorAuthorityIdentities.keys.get(source);
  if (identity === undefined) {
    identity = operatorAuthorityIdentities.nextId++;
    operatorAuthorityIdentities.keys.set(source, identity);
  }
  return JSON.stringify([
    authority.profileId,
    [...new Set(authority.scopes.map((scope) => scope.trim()).filter(Boolean))].toSorted(),
    identity,
  ]);
}

export function assertCurrentOperatorAuthority(
  authority: AdmittedRunOperatorAuthority | undefined,
): void {
  if (authority) {
    assertAdmittedRunOperatorAuthority(authority);
    authority.assertCurrent();
  }
}

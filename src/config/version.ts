// Normalizes config version metadata and compatibility comparisons.
import { parse as parseSemver, type SemVer } from "semver";
import {
  compareOpenClawSemver,
  isOpenClawCorrectionSemver,
  normalizeLegacyDotBetaVersion,
} from "../infra/semver.js";

/** Parses stable, prerelease, and legacy dot-beta OpenClaw versions. */
function parseOpenClawVersion(raw: string | null | undefined): SemVer | null {
  if (!raw) {
    return null;
  }
  const normalized = normalizeLegacyDotBetaVersion(raw.trim());
  return parseSemver(normalized);
}

function isMainSnapshotVersion(version: SemVer): boolean {
  return (
    version.prerelease.length === 2 &&
    version.prerelease[0] === "main" &&
    /^[0-9a-f]{7,40}$/i.test(String(version.prerelease[1]))
  );
}

export function normalizeOpenClawVersionBase(raw: string | null | undefined): string | null {
  const parsed = parseOpenClawVersion(raw);
  if (!parsed) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function compareOpenClawVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const parsedA = parseOpenClawVersion(a);
  const parsedB = parseOpenClawVersion(b);
  if (!parsedA || !parsedB) {
    return null;
  }
  return compareOpenClawSemver(parsedA, parsedB);
}

export function shouldWarnOnTouchedVersion(
  current: string | null | undefined,
  touched: string | null | undefined,
): boolean {
  const parsedCurrent = parseOpenClawVersion(current);
  const parsedTouched = parseOpenClawVersion(touched);
  if (parsedCurrent && parsedTouched && parsedCurrent.compareMain(parsedTouched) === 0) {
    if (parsedTouched.prerelease.length === 0 || isOpenClawCorrectionSemver(parsedTouched)) {
      return false;
    }
    if (isMainSnapshotVersion(parsedCurrent) && isMainSnapshotVersion(parsedTouched)) {
      return false;
    }
  }
  return parsedCurrent !== null && parsedTouched !== null
    ? compareOpenClawSemver(parsedCurrent, parsedTouched) < 0
    : false;
}

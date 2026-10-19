/**
 * Privacy regression guard for tracked source and test fixtures.
 *
 * Never commit a real customer/owner phone number. Use a clearly synthetic,
 * reserved fixture instead — the NANP `+1 555 01xx` range (for example
 * `+15550001234` or `15550001234`), which is the convention already used
 * across this suite. This guard normalizes phone-like runs (spaces, dashes,
 * dots, parentheses, leading `+`) and fails when a known real number is
 * reintroduced in any representation.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Split into small fragments so this guard never embeds the forbidden
// literals (or even a recognisable contiguous chunk) in the repository.
const FORBIDDEN_NATIONAL = [
  ["37", "04", "86", "84", "21"].join(""), // confirmed real owner number (rounds 4/5)
  ["37", "04", "81", "92", "34"].join(""), // unverified number removed from filters.test.ts
];

// A phone-like run: optional +, then at least 8 digits with common separators.
const PHONE_RUN = /\+?\d(?:[\d\s().-]{6,})\d/g;

function normalizedRuns(line: string): string[] {
  return (line.match(PHONE_RUN) ?? []).map((run) => run.replace(/\D/g, ""));
}

function trackedSourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "src", "tests"], {
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

function violationsIn(file: string): string[] {
  const hits: string[] = [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const runs = normalizedRuns(line);
    if (
      runs.some((run) =>
        FORBIDDEN_NATIONAL.some((national) => run.includes(national))
      )
    ) {
      hits.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

describe("privacy fixtures", () => {
  it("never reintroduces real phone numbers in tracked src/tests", () => {
    const files = trackedSourceFiles();
    // Fail loudly instead of passing vacuously if the scan surface moved.
    assert.ok(
      files.includes("src/lib/messaging/security-round4.test.ts"),
      "privacy guard did not resolve the tracked source tree"
    );
    const violations = files.flatMap(violationsIn);
    assert.deepEqual(
      violations,
      [],
      "Real phone fixtures are forbidden. Replace them with the synthetic " +
        "+1 555 01xx range documented at the top of this file."
    );
  });
});

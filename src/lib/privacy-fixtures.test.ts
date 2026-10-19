/**
 * Privacy regression guard for every git-tracked text file.
 *
 * Forbidden values are stored ONLY as one-way SHA-256 digests; there are no
 * reversible fragments, joined string pieces, or recognizable digit chunks in
 * this file. The scanner builds a digit stream per file (all non-digit
 * characters removed), so it detects numbers written contiguously, with
 * whitespace/punctuation separators, or split across source-string
 * concatenation. Every 10- and 13-digit window is hashed and compared.
 *
 * Failure output is deliberately redacted: file path + line/range + a digest
 * prefix. Raw lines, values, and matched digit windows are never printed.
 *
 * Safe fixture convention: use the reserved NANP `+1 555 01xx` range (for
 * example `+15550001234`) for phone numbers in tests.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

type DigestRegistry = ReadonlyMap<number, readonly string[]>;

const FORBIDDEN_DIGESTS: DigestRegistry = new Map<number, readonly string[]>([
  [
    10,
    [
      "1c4294ea305036e1c046e52ea885d702d559c5d0fc80e91ea6588a9e7480510a",
      "7263ea36e84af50a7b1b1618d3ab3bafd5a694adfed9126b6524e5240e5911ad",
    ],
  ],
  [
    13,
    [
      "966669a8f75a707a68704c488657baddaf5d988f4c9d836365c366dfd84f3dcb",
      "7127092131b096d1a528b1312998aa2fb69249d25c98c59dd555b73ef13cb96d",
    ],
  ],
]);

const BINARY_PROBE_BYTES = 8192;
const DIGIT_RUN = /^[0-9]+$/;

export interface PrivacyViolation {
  /** Repository-relative path, forward-slash separated. */
  path: string;
  /** 1-based line, or `start-end` when the match spans lines. */
  lines: string;
  /** Prefix of the one-way digest of the matched digit window. */
  digestPrefix: string;
}

interface DigitStream {
  digits: string;
  /** Original character offset for each digit in `digits`. */
  positions: number[];
}

interface DigitMatch {
  start: number;
  length: number;
  digest: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isProbablyBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
  return probe.includes(0);
}

export function repositoryRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function trackedFiles(root: string): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function toDigitStream(text: string): DigitStream {
  const digits: string[] = [];
  const positions: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (DIGIT_RUN.test(char)) {
      digits.push(char);
      positions.push(index);
    }
  }
  return { digits: digits.join(""), positions };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return high + 1;
}

function findDigitMatches(
  digits: string,
  registry: DigestRegistry
): DigitMatch[] {
  const matches: DigitMatch[] = [];
  for (const [length, digests] of registry) {
    if (digests.length === 0 || digits.length < length) continue;
    const forbidden = new Set(digests);
    for (let start = 0; start + length <= digits.length; start += 1) {
      const digest = sha256(digits.slice(start, start + length));
      if (forbidden.has(digest)) {
        matches.push({ start, length, digest });
      }
    }
  }
  return matches;
}

export function scanTrackedText(
  path: string,
  text: string,
  registry: DigestRegistry = FORBIDDEN_DIGESTS
): PrivacyViolation[] {
  const stream = toDigitStream(text);
  const matches = findDigitMatches(stream.digits, registry);
  if (matches.length === 0) return [];
  const starts = lineStarts(text);
  return matches.map((match) => {
    const first = stream.positions[match.start];
    const last = stream.positions[match.start + match.length - 1];
    const startLine = lineAt(starts, first);
    const endLine = lineAt(starts, last);
    return {
      path,
      lines: startLine === endLine ? String(startLine) : `${startLine}-${endLine}`,
      digestPrefix: match.digest.slice(0, 16),
    };
  });
}

export function formatViolation(violation: PrivacyViolation): string {
  return `${violation.path}:${violation.lines} sha256:${violation.digestPrefix}…`;
}

function loadTrackedText(
  root: string
): { path: string; text: string }[] {
  const texts: { path: string; text: string }[] = [];
  for (const path of trackedFiles(root)) {
    const buffer = readFileSync(resolve(root, path));
    if (isProbablyBinary(buffer)) continue;
    texts.push({ path, text: buffer.toString("utf8") });
  }
  return texts;
}

describe("privacy detector", () => {
  // Synthetic, reserved +1 555 fixtures. Digests are computed in-test; no
  // real value is stored anywhere in this file.
  const syntheticRegistry: DigestRegistry = new Map<number, readonly string[]>([
    [10, [sha256("5550009876")]],
    [11, [sha256("15550001234")]],
    [13, [sha256("1555555001234")]],
  ]);
  const scan = (text: string) =>
    scanTrackedText("fixture.ts", text, syntheticRegistry);

  it("detects contiguous synthetic +1555 forms", () => {
    assert.equal(scan("const phone = '+15550001234';").length, 1);
    assert.equal(scan("national=5550009876").length, 1);
    assert.equal(scan("international=1555555001234").length, 1);
  });

  it("detects whitespace/punctuation-separated forms", () => {
    assert.equal(scan("+1 (555) 000-1234").length, 1);
    assert.equal(scan("555.000.9876").length, 1);
    assert.equal(scan("555 000 9876").length, 1);
    assert.equal(scan("1 (555) 555-001-234").length, 1);
  });

  it("detects split-string and concatenated source forms", () => {
    assert.equal(scan('const p = "15550" + "001234";').length, 1);
    assert.equal(scan('["555000", "9876"].join("")').length, 1);
    assert.equal(scan('"1555" +\n  "0001234"').length, 1);
    assert.equal(scan('"1555" + "555" + "001234"').length, 1);
  });

  it("scans all tracked text files and skips binaries", () => {
    const root = repositoryRoot();
    const paths = loadTrackedText(root).map((file) => file.path);
    assert.ok(paths.includes("package.json"), "expected root-level files");
    assert.ok(
      paths.includes("docs/socialcrm/security-remediation.md"),
      "expected docs outside src/tests"
    );
    assert.ok(
      !paths.includes("docs/analisis-ventas-whatsapp-septiembre-2026.docx"),
      "expected binary files to be skipped"
    );
  });

  it("never emits raw content in failure output", () => {
    const text = "secret-customer +1 (555) 000-1234 must stay private";
    const formatted = scan(text).map(formatViolation).join("\n");
    assert.match(formatted, /fixture\.ts:1/);
    assert.match(formatted, /sha256:[0-9a-f]{16}…/);
    assert.doesNotMatch(formatted, /15550001234|5550001234/);
    assert.doesNotMatch(formatted, /secret-customer|must stay private/);
  });
});

describe("privacy fixtures", () => {
  it("never reintroduces real phone numbers in tracked files", () => {
    const root = repositoryRoot();
    const files = loadTrackedText(root);
    assert.ok(
      files.some((file) => file.path === "src/lib/messaging/security-round4.test.ts"),
      "privacy guard did not resolve the tracked source tree"
    );
    const violations = files.flatMap((file) =>
      scanTrackedText(file.path, file.text)
    );
    assert.deepEqual(
      violations.map(formatViolation),
      [],
      "Real phone fixtures are forbidden. Replace them with the synthetic " +
        "+1 555 01xx range documented at the top of this file."
    );
  });
});

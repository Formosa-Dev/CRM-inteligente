import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the OAuth-state cookie path drift: the nonce cookie is
 * set with `path: "/api/meta"` in generateMetaOAuthState but was deleted with
 * the default `"/"` — browsers ignore a delete whose path differs, so the
 * CSRF nonce stayed replayable for its whole TTL.
 *
 * Both call sites live in different files, so the invariant is asserted at
 * the source level: the `path` used on set must equal the `path` on delete.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const actionsSrc = readFileSync(
  path.join(here, "..", "..", "(admin)", "admin", "meta", "actions.ts"),
  "utf8"
);
const callbackSrc = readFileSync(
  path.join(here, "callback", "route.ts"),
  "utf8"
);

function declaredPath(source: string, call: "set" | "delete"): string | null {
  const block = source.match(
    new RegExp(`cookieStore\\.${call}\\([\\s\\S]*?\\)\\s*;`)
  );
  return block?.[0].match(/path:\s*"([^"]+)"/)?.[1] ?? null;
}

test("meta oauth state cookie is deleted with the same path it was set", () => {
  const setPath = declaredPath(actionsSrc, "set");
  const deletePath = declaredPath(callbackSrc, "delete");
  assert.equal(setPath, "/api/meta");
  assert.equal(deletePath, setPath);
});

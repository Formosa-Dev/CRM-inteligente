import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentAgentConfigScope,
  parseScopeKey,
  runWithAgentConfigScope,
  scopeKeyOf,
} from "./agent-config-scope";

// S13 — pure scope-key/ALS behavior. DB resolution paths are exercised
// indirectly via the consistency suite; unit coverage here pins the identity
// contract the admin UI and cache keys rely on.

test("scopeKeyOf prefers account over channel over global", () => {
  assert.equal(scopeKeyOf({}), "global");
  assert.equal(scopeKeyOf({ channel: "whatsapp" }), "channel:whatsapp");
  assert.equal(scopeKeyOf({ channelAccountId: 7 }), "account:7");
  assert.equal(
    scopeKeyOf({ channel: "whatsapp", channelAccountId: 7 }),
    "account:7"
  );
});

test("parseScopeKey round-trips scopeKeyOf", () => {
  for (const key of ["global", "channel:telegram", "account:42"]) {
    const parsed = parseScopeKey(key);
    assert.ok(parsed);
    assert.equal(scopeKeyOf(parsed), key);
  }
});

test("parseScopeKey rejects malformed keys", () => {
  assert.equal(parseScopeKey("bogus"), null);
  assert.equal(parseScopeKey("channel:bogus"), null);
  assert.equal(parseScopeKey("account:abc"), null);
  assert.equal(parseScopeKey("account:-3"), null);
  assert.equal(parseScopeKey("account:0"), null);
});

test("empty/missing scope keys mean the global scope", () => {
  assert.deepEqual(parseScopeKey(""), {});
  assert.deepEqual(parseScopeKey(null), {});
  assert.deepEqual(parseScopeKey(undefined), {});
});

test("ambient scope flows through async work and never leaks between runs", async () => {
  assert.deepEqual(currentAgentConfigScope(), {});

  const seen = await runWithAgentConfigScope(
    { channelAccountId: 5 },
    async () => {
      await new Promise((r) => setTimeout(r, 0));
      return currentAgentConfigScope();
    }
  );
  assert.deepEqual(seen, { channelAccountId: 5 });
  assert.deepEqual(currentAgentConfigScope(), {});

  // Two overlapping runs keep independent scopes.
  const [a, b] = await Promise.all([
    runWithAgentConfigScope({ channel: "whatsapp" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentAgentConfigScope();
    }),
    runWithAgentConfigScope({ channelAccountId: 9 }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentAgentConfigScope();
    }),
  ]);
  assert.deepEqual(a, { channel: "whatsapp" });
  assert.deepEqual(b, { channelAccountId: 9 });
});

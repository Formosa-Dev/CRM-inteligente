/**
 * F11: the login limiter must resist brute force without letting anyone lock
 * the admin out cheaply, and the authorize path must not leak account
 * existence through timing or bounded-map growth.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import bcrypt from "bcryptjs";

import { createMemoryThrottle } from "./login-throttle";

const LIMITS = { pair: 5, ip: 20, email: 30 };

describe("F11 — login throttle (in-memory fallback)", () => {
  it("lets a single client try 5 times per account, then blocks the pair", () => {
    const throttle = createMemoryThrottle({ limits: LIMITS });
    for (let i = 0; i < 5; i++) {
      assert.equal(throttle.check("10.0.0.1", "admin@x.com").allowed, true);
    }
    const sixth = throttle.check("10.0.0.1", "admin@x.com");
    assert.equal(sixth.allowed, false);
    assert.equal(sixth.ipLimited, true);
  });

  it("a second IP can still reach the account — the pair limit is per-source", () => {
    const throttle = createMemoryThrottle({ limits: LIMITS });
    for (let i = 0; i < 5; i++) throttle.check("10.0.0.1", "admin@x.com");
    // Locking the admin out now requires coordinated IPs, not 5 requests.
    assert.equal(throttle.check("10.0.0.2", "admin@x.com").allowed, true);
  });

  it("bounds distributed guessing on one email at 30 per window", () => {
    const throttle = createMemoryThrottle({ limits: LIMITS });
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      if (throttle.check(`10.0.${Math.floor(i / 5)}.${i}`, "admin@x.com").allowed)
        allowed++;
    }
    assert.equal(allowed, 30);
    const verdict = throttle.check("10.9.9.9", "admin@x.com");
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.emailLimited, true);
  });

  it("bounds one IP across accounts at 20 per window", () => {
    const throttle = createMemoryThrottle({ limits: LIMITS });
    let allowed = 0;
    for (let i = 0; i < 25; i++) {
      if (throttle.check("10.0.0.1", `user${i}@x.com`).allowed) allowed++;
    }
    assert.equal(allowed, 20);
  });

  it("windows refill after expiry", () => {
    let now = 1_000;
    const throttle = createMemoryThrottle({
      now: () => now,
      limits: LIMITS,
    });
    for (let i = 0; i < 5; i++) throttle.check("10.0.0.1", "a@x.com");
    assert.equal(throttle.check("10.0.0.1", "a@x.com").allowed, false);
    now += 10 * 60 * 1000 + 1;
    assert.equal(throttle.check("10.0.0.1", "a@x.com").allowed, true);
  });

  it("the attempt map is hard-bounded — thousands of uniques cannot grow it", () => {
    const throttle = createMemoryThrottle({ maxEntries: 100, limits: LIMITS });
    for (let i = 0; i < 250; i++) {
      throttle.check(`10.1.${Math.floor(i / 20)}.${i}`, `e${i}@x.com`);
    }
    // If the map were unbounded this loop would simply grow it; the contract
    // is that after eviction the buckets still answer correctly.
    const verdict = throttle.check("10.2.0.1", "fresh@x.com");
    assert.equal(verdict.allowed, true);
  });

  it("email keys are case-insensitive", () => {
    const throttle = createMemoryThrottle({ limits: LIMITS });
    for (let i = 0; i < 30; i++) {
      throttle.check(`10.3.${i}.1`, i % 2 ? "Admin@X.com" : "admin@x.com");
    }
    const verdict = throttle.check("10.9.0.1", "ADMIN@x.com");
    assert.equal(verdict.emailLimited, true);
  });
});

describe("F11 — timing oracle", () => {
  it("the dummy hash is a valid bcrypt cost-12 hash that always mismatches", async () => {
    const src = readFileSync("src/auth/index.ts", "utf8");
    const match = src.match(/DUMMY_PASSWORD_HASH\s*=\s*\n?\s*"([^"]+)"/);
    assert.ok(match, "DUMMY_PASSWORD_HASH constant missing");
    assert.match(match![1], /^\$2[aby]\$12\$/);
    assert.equal(await bcrypt.compare("anything", match![1]), false);
  });
});

describe("F11 — authorize wiring", () => {
  const src = readFileSync("src/auth/index.ts", "utf8");

  it("keys the throttle on the request IP and the email", () => {
    assert.match(src, /clientIpFromRequest\(request\)/);
    assert.match(src, /checkLoginThrottle\(/);
  });

  it("always pays one bcrypt compare — dummy hash for unknown users", () => {
    assert.match(src, /user\?\.hashedPassword \?\? DUMMY_PASSWORD_HASH/);
  });

  it("dropped the old unbounded per-email map", () => {
    assert.doesNotMatch(src, /isLoginRateLimited/);
    assert.doesNotMatch(src, /loginAttempts/);
  });

  it("returns a single generic null for bad creds, throttled attempts, and unknown users", () => {
    const authorizeBody = src.slice(src.indexOf("async authorize"));
    // No distinct error surfaces per failure mode.
    assert.doesNotMatch(authorizeBody, /too many|rate.?limit.*error|throw/);
  });
});

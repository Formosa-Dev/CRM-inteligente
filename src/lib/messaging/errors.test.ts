import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyError,
  errorCode,
  isRetryableDbError,
  isSchemaNotReady,
  shouldRetryError,
} from "./errors";

describe("schema-not-ready is positively identified only", () => {
  it("recognizes missing tables/columns", () => {
    assert.equal(isSchemaNotReady({ code: "42P01" }), true);
    assert.equal(isSchemaNotReady({ code: "42703" }), true);
    assert.equal(isSchemaNotReady({ code: "3F000" }), true);
  });

  it("does not treat an arbitrary or missing-DATABASE_URL error as schema drift", () => {
    assert.equal(isSchemaNotReady(new Error("DATABASE_URL environment variable is not set")), false);
    assert.equal(isSchemaNotReady({ code: "23505" }), false);
    assert.equal(isSchemaNotReady(undefined), false);
    assert.equal(isRetryableDbError(new Error("DATABASE_URL environment variable is not set")), false);
  });
});

describe("retryable database failures", () => {
  it("recognizes SQLSTATE transients and network errors", () => {
    for (const code of ["40001", "40P01", "57P01", "08006", "53300"]) {
      assert.equal(isRetryableDbError({ code }), true, code);
    }
    assert.equal(isRetryableDbError(new Error("fetch failed")), true);
    assert.equal(isRetryableDbError({ code: "ECONNRESET" }), true);
    assert.equal(isRetryableDbError({ cause: { code: "ETIMEDOUT" } }), true);
  });

  it("classifies and only retries the retryable class", () => {
    assert.equal(classifyError({ code: "42P01" }), "schema-not-ready");
    assert.equal(classifyError({ code: "57P01" }), "retryable-db");
    assert.equal(shouldRetryError({ code: "57P01" }), true);
    assert.equal(shouldRetryError({ code: "23505" }), false);
  });

  it("reads nested cause codes", () => {
    assert.equal(errorCode({ cause: { code: "ETIMEDOUT" } }), "ETIMEDOUT");
  });

  it("honors an explicit retryable marker without a SQLSTATE", () => {
    assert.equal(classifyError({ retryable: true }), "retryable-db");
    assert.equal(shouldRetryError({ retryable: true }), true);
    assert.equal(classifyError({ retryable: false }), "unknown");
  });
});

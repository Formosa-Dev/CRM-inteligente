import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateWebhookStatuses } from "./webhook-response";

describe("aggregateWebhookStatuses", () => {
  it("returns 503 if ANY event failed retryably, even after a success", () => {
    assert.deepEqual(aggregateWebhookStatuses([200, 503, 200]), {
      status: 503,
      ok: false,
      retryable: true,
    });
  });

  it("returns 200 only when every event succeeded", () => {
    assert.deepEqual(aggregateWebhookStatuses([200, 200]), {
      status: 200,
      ok: true,
      retryable: false,
    });
    assert.equal(aggregateWebhookStatuses([]).status, 200);
  });

  it("propagates non-retryable server/client failures", () => {
    assert.equal(aggregateWebhookStatuses([200, 500]).status, 500);
    assert.equal(aggregateWebhookStatuses([200, 400]).status, 400);
    assert.equal(aggregateWebhookStatuses([503, 500]).status, 503);
  });
});

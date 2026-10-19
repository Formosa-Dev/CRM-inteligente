import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  autoReplyMarkerKey,
  shouldSendAutoReply,
} from "./inbound-pipeline";

describe("first-contact auto-reply retry safety", () => {
  it("sends on a brand-new conversation", () => {
    assert.equal(
      shouldSendAutoReply({
        isNew: true,
        alreadyReplied: false,
        conversationHasMessages: false,
      }),
      true
    );
  });

  it("retries the first contact after a retryable send failure", () => {
    // The conversation row committed on attempt 1, but no message did.
    assert.equal(
      shouldSendAutoReply({
        isNew: false,
        alreadyReplied: false,
        conversationHasMessages: false,
      }),
      true
    );
  });

  it("never duplicates a recorded reply or replies in an established thread", () => {
    assert.equal(
      shouldSendAutoReply({
        isNew: true,
        alreadyReplied: true,
        conversationHasMessages: true,
      }),
      false
    );
    assert.equal(
      shouldSendAutoReply({
        isNew: false,
        alreadyReplied: false,
        conversationHasMessages: true,
      }),
      false
    );
  });

  it("derives a deterministic marker from the inbound message id", () => {
    assert.equal(autoReplyMarkerKey("wamid.1"), "auto-reply:wamid.1");
    assert.equal(autoReplyMarkerKey("wamid.1"), autoReplyMarkerKey("wamid.1"));
  });
});

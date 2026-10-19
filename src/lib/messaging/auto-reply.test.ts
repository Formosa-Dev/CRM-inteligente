import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  autoReplyClaimKey,
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

  it("derives a deterministic claim key from the conversation id (A-13)", () => {
    // Conversation-scoped: two different inbound messages of the SAME
    // conversation share one claim, so only the first concurrent path
    // that lands the unique insert may send the welcome.
    assert.equal(autoReplyClaimKey(101), "auto-reply:conv:101");
    assert.equal(autoReplyClaimKey(101), autoReplyClaimKey(101));
    assert.notEqual(autoReplyClaimKey(101), autoReplyClaimKey(202));
  });

  it("claims before sending and releases the claim on failure", () => {
    const pipeline = readFileSync("src/lib/messaging/inbound-pipeline.ts", "utf8");
    const block = pipeline.slice(
      pipeline.indexOf("const claimKey = autoReplyClaimKey(conversationId)"),
      pipeline.indexOf("// 9. Persist inbound message")
    );
    // Ordering inside the block: claim insert → send → release on failure.
    const claimAt = block.indexOf("const claim = await insertMessage(");
    const sendAt = block.indexOf("messenger.send(");
    const releaseAt = block.indexOf(".delete(chatMessages)");
    const idemAt = block.indexOf("idempotencyKey: claimKey");
    assert.ok(claimAt !== -1 && sendAt !== -1 && releaseAt !== -1 && idemAt !== -1);
    assert.ok(claimAt < sendAt, "the claim must be taken before the send");
    assert.ok(sendAt < releaseAt, "the claim is released only after a failed send");
    // The losing path never sends.
    assert.match(block, /claim\.wasDuplicate/);
  });
});

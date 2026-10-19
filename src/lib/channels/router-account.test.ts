import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectBoundConversationId } from "./router";

describe("selectBoundConversationId", () => {
  it("returns the row bound to the selected account, not a legacy row", () => {
    const rows = [
      { id: 10, channelAccountId: null },
      { id: 11, channelAccountId: 7 },
    ];
    assert.equal(selectBoundConversationId(rows, 7), 11);
  });

  it("returns undefined when no row is bound to the account", () => {
    assert.equal(
      selectBoundConversationId([{ id: 10, channelAccountId: null }], 7),
      undefined
    );
  });
});

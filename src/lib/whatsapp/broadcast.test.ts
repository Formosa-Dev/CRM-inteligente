import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  shouldBlockDuplicateBroadcast,
  formatBroadcastPreview,
  claimBroadcastRun,
  _resetInFlightBroadcasts,
  DUPLICATE_BROADCAST_THRESHOLD,
  DUPLICATE_BROADCAST_WINDOW_MINUTES,
  BROADCAST_HARD_LIMIT,
} from "./broadcast";

const broadcastSource = readFileSync(
  new URL("./broadcast.ts", import.meta.url),
  "utf8",
);
const toolsSource = readFileSync(
  new URL("../telegram/toolsWhatsApp.ts", import.meta.url),
  "utf8",
);

describe("duplicate broadcast guard", () => {
  test("blocks when the same text already reached the threshold recently", () => {
    assert.equal(shouldBlockDuplicateBroadcast(3, false), true);
    assert.equal(shouldBlockDuplicateBroadcast(10, false), true);
  });

  test("does not block below the threshold", () => {
    assert.equal(shouldBlockDuplicateBroadcast(0, false), false);
    assert.equal(shouldBlockDuplicateBroadcast(DUPLICATE_BROADCAST_THRESHOLD - 1, false), false);
  });

  test("admin can force a resend with allowDuplicate", () => {
    assert.equal(shouldBlockDuplicateBroadcast(50, true), false);
  });
});

describe("broadcast preview formatting", () => {
  const recipients = [
    { phone: "5493704111111", name: "Ana" },
    { phone: "5493704222222", name: null },
    { phone: "5493704333333", name: "Carlos" },
  ];

  test("shows total matched and recipient list without sending", () => {
    const out = formatBroadcastPreview({
      filterLabel: "24h",
      totalMatched: 3,
      recipients,
      maxRecipients: 50,
      capped: false,
    });
    assert.match(out, /3 destinatarios/);
    assert.match(out, /Ana — 5493704111111/);
    assert.match(out, /sin nombre — 5493704222222/);
    assert.match(out, /No envié nada/);
  });

  test("warns when recipients exceed maxRecipients cap", () => {
    const out = formatBroadcastPreview({
      filterLabel: "todos",
      totalMatched: 80,
      recipients,
      maxRecipients: 50,
      capped: true,
    });
    assert.match(out, /80 destinatarios/);
    assert.match(out, /se mandaría a los primeros 50/);
  });
});

describe("24h window uses inbound messages, not bot activity", () => {
  test("the 24h-window filter checks chat_messages role='user'", () => {
    // lastMessageAt is touched by the bot's own messages (incl. broadcasts),
    // so the real WhatsApp window must come from inbound user messages.
    assert.match(broadcastSource, /chat_messages m\s+where m\.conversation_id/);
    assert.match(broadcastSource, /m\.role = 'user'/);
    assert.doesNotMatch(
      broadcastSource.slice(broadcastSource.indexOf('"24h-window"'), broadcastSource.indexOf('case "has-ordered"')),
      /gte\(conversations\.lastMessageAt/,
    );
  });
});

describe("tool wiring", () => {
  test("broadcastWhatsApp exposes dryRun and allowDuplicate", () => {
    assert.match(toolsSource, /dryRun:\s*z\s*\.boolean\(\)/);
    assert.match(toolsSource, /allowDuplicate:\s*z\s*\.boolean\(\)/);
    assert.match(toolsSource, /formatBroadcastPreview/);
    assert.match(toolsSource, /countRecentBroadcastSends/);
    assert.match(toolsSource, /shouldBlockDuplicateBroadcast/);
  });

  test("recipients are sliced from the full match so the cap is never silent", () => {
    assert.match(toolsSource, /matched\.slice\(0, maxRecipients\)/);
    assert.match(toolsSource, /matchea \$\{matched\.length\}/);
  });
});

describe("safety constants", () => {
  test("constants are sane", () => {
    assert.ok(BROADCAST_HARD_LIMIT >= 100);
    assert.ok(DUPLICATE_BROADCAST_WINDOW_MINUTES >= 5);
    assert.ok(DUPLICATE_BROADCAST_THRESHOLD >= 2);
  });
});

// A-45: the check-then-act DB count raced for concurrent sends, and
// broadcasts of 1–2 recipients never reached the threshold. broadcastText
// now claims the run in-process and dedupes per recipient.
describe("A-45 concurrent + small-recipient duplicate hardening", () => {
  test("in-flight claim rejects a concurrent identical broadcast", () => {
    _resetInFlightBroadcasts();
    const release = claimBroadcastRun("promo del sábado");
    assert.ok(release, "first claim wins");
    assert.equal(claimBroadcastRun("promo del sábado"), null, "concurrent same text blocked");
    assert.ok(claimBroadcastRun("otro texto") !== null, "different text not blocked");
    release!();
    assert.ok(claimBroadcastRun("promo del sábado") !== null, "released claim allows a later run");
    _resetInFlightBroadcasts();
  });

  test("broadcastText applies the claim and per-recipient dedup", () => {
    const body = broadcastSource.slice(broadcastSource.indexOf("export async function broadcastText"));
    assert.match(body, /claimBroadcastRun\(text\)/);
    assert.match(body, /phonesAlreadySentBroadcast\(text,/);
    assert.match(body, /skippedDuplicates/);
    assert.match(body, /omitido — ya recibió este texto/);
    assert.match(body, /finally \{\s*release\(\)/, "claim is always released");
  });

  test("per-recipient dedup joins conversations via chat_messages", () => {
    const fn = broadcastSource.slice(broadcastSource.indexOf("phonesAlreadySentBroadcast"));
    assert.match(fn, /innerJoin\(conversations/);
    assert.match(fn, /eq\(chatMessages\.role, "assistant"\)/);
    assert.match(fn, /eq\(chatMessages\.content, text\)/);
  });
});

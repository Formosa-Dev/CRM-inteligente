import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  argentinaDayKey,
  argentinaDayStart,
  buildTemporalAgentMessages,
  classifyTurnIntent,
  evaluateOrderLifecycle,
  filterSameDayActiveCartRows,
  formatArgentinaStamp,
  isNonOrderingText,
  KEEP_ACTIVE_ORDER_MARKER,
  planOrderCreation,
  segmentHistoryByDay,
  wantsSeparateOrder,
  type OrderCreationFacts,
} from "./temporal-context";
import {
  autoCloseStaleOrder,
  type OrderLifecycleRepository,
} from "./order-lifecycle";

// Argentina is UTC-3 with no DST, so UTC midnight is 21:00 local the day before.

const HOUR = 3_600_000;

function facts(overrides: Partial<OrderCreationFacts>): OrderCreationFacts {
  return {
    turnText: "",
    replyToNotification: false,
    sameDayCartItems: [],
    explicitItems: undefined,
    activeOrder: null,
    now: new Date("2026-10-13T18:00:00Z"),
    ...overrides,
  };
}

describe("Argentina local calendar boundaries", () => {
  test("UTC/local midnight rolls the calendar day at 03:00Z", () => {
    assert.equal(argentinaDayKey(new Date("2026-10-13T02:59:59Z")), "2026-10-12");
    assert.equal(argentinaDayKey(new Date("2026-10-13T03:00:00Z")), "2026-10-13");
    assert.equal(argentinaDayKey(new Date("2026-10-12T23:00:00Z")), "2026-10-12");
  });

  test("stamps are rendered as [DD/MM HH:mm] in Argentina time", () => {
    assert.equal(formatArgentinaStamp(new Date("2026-10-13T03:05:00Z")), "[13/10 00:05]");
    assert.equal(formatArgentinaStamp(new Date("2026-10-13T18:30:00Z")), "[13/10 15:30]");
  });

  test("argentinaDayStart is the UTC instant of local midnight", () => {
    // 2026-10-13T02:59:59Z is still 12/10 locally → day starts 12/10 03:00Z.
    assert.equal(argentinaDayStart(new Date("2026-10-13T02:59:59Z")).toISOString(), "2026-10-12T03:00:00.000Z");
    // 2026-10-13T03:00:00Z is the first instant of 13/10 locally.
    assert.equal(argentinaDayStart(new Date("2026-10-13T03:00:00Z")).toISOString(), "2026-10-13T03:00:00.000Z");
  });
});

describe("midnight cart must not leak into the next local day", () => {
  // now = 13/10 00:15 Argentina local (03:15Z).
  const now = new Date("2026-10-13T03:15:00Z");

  test("a cart created yesterday 23:59 local with expiry after midnight is ignored", () => {
    const midnightCart = {
      status: "active",
      createdAt: new Date("2026-10-13T02:59:00Z"), // 12/10 23:59 local
      expiresAt: new Date("2026-10-13T03:29:00Z"), // 13/10 00:29 local → still unexpired
    };

    // Active + unexpired, but from the preceding local day → excluded.
    assert.deepEqual(filterSameDayActiveCartRows([midnightCart], now), []);

    // With the leaking cart excluded, a "lo de siempre" turn has no grounding
    // and cannot materialize an order from yesterday's items.
    const plan = planOrderCreation(facts({
      now,
      turnText: "quiero lo de siempre",
      sameDayCartItems: filterSameDayActiveCartRows([midnightCart], now).map((ci) => ({ name: "Deli Deli", quantity: 2 })),
    }));
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.equal(plan.reason, "no_current_day_items");
  });

  test("a cart created today remains eligible", () => {
    const todayCart = {
      status: "active",
      createdAt: new Date("2026-10-13T03:10:00Z"), // 13/10 00:10 local
      expiresAt: new Date("2026-10-13T03:40:00Z"),
    };

    const kept = filterSameDayActiveCartRows([todayCart], now);
    assert.equal(kept.length, 1);

    const plan = planOrderCreation(facts({
      now,
      turnText: "quiero lo que tenía",
      sameDayCartItems: kept.map((ci) => ({ name: "Deli Deli", quantity: 2 })),
    }));
    assert.equal(plan.kind, "create");
    if (plan.kind === "create") {
      assert.deepEqual(plan.items, [{ name: "Deli Deli", quantity: 2 }]);
    }
  });
});

describe("day segmentation passed to the model", () => {
  test("older days are labelled and separated from today by a boundary", () => {
    const now = new Date("2026-10-13T18:00:00Z");
    const result = segmentHistoryByDay(
      [
        { role: "user", content: "2 Deli Deli", createdAt: new Date("2026-10-06T23:00:00Z") },
        { role: "assistant", content: "listo", createdAt: new Date("2026-10-06T23:01:00Z") },
        { role: "user", content: "nooo", createdAt: now },
      ],
      now,
    );

    assert.equal(result.todayDayKey, "2026-10-13");
    assert.equal(result.todayCount, 1);
    assert.equal(result.olderCount, 2);
    assert.deepEqual(result.olderDayKeys, ["2026-10-06"]);
    assert.equal(result.messages[0].content.startsWith("[06/10 "), true);
    assert.match(result.messages[0].content, /2 Deli Deli$/);
    const boundary = result.messages.find((m) => m.role === "system");
    assert.ok(boundary, "a day boundary must be injected");
    assert.match(boundary!.content, /HOY es 13\/10/);
    assert.match(boundary!.content, /SECUNDARIO/);
    // Today's message is primary → unlabelled and last in order.
    assert.deepEqual(result.messages[result.messages.length - 1], { role: "user", content: "nooo" });
  });

  test("buffered turn is deduped, dated today, and older turns stay labelled", () => {
    const now = new Date("2026-10-13T18:00:00Z");
    const history = [
      { role: "user", content: "2 Deli Deli", createdAt: new Date("2026-10-06T23:00:00Z"), platformMessageId: "old-1" },
      { role: "assistant", content: "listo", createdAt: new Date("2026-10-06T23:01:00Z"), platformMessageId: "old-2" },
      { role: "user", content: "nooo", createdAt: new Date("2026-10-13T17:59:00Z"), platformMessageId: "m1" },
    ];
    const result = buildTemporalAgentMessages(history, [{ content: "nooo", messageId: "m1" }], now);

    const userTurns = result.messages.filter((m) => m.role === "user");
    assert.equal(userTurns.filter((m) => m.content === "nooo").length, 1, "buffered turn must not duplicate");
    assert.equal(result.todayCount, 1);
    assert.equal(result.olderCount, 2);
  });
});

describe("turn intent classification", () => {
  test("greetings, acks, reactions and recurrences are non-ordering", () => {
    for (const text of ["hola", "buenas", "okis", "ok", "dale", "gracias", "nooo", "👍", "lo de siempre", "la misma de siempre"]) {
      assert.equal(isNonOrderingText(text), true, `expected non-ordering: ${text}`);
      assert.notEqual(classifyTurnIntent(text), "explicit_order");
    }
  });

  test("explicit product + purchase text is an order", () => {
    for (const text of ["quiero 2 Deli Deli", "dame una bookbinder", "agregame media docena de prepizza"]) {
      assert.equal(classifyTurnIntent(text), "explicit_order", `expected order: ${text}`);
    }
  });
});

describe("material order-creation guard", () => {
  test("old-day item + today 'nooo' never creates an order", () => {
    const plan = planOrderCreation(facts({
      turnText: "nooo",
      explicitItems: [{ name: "Deli Deli", quantity: 2 }],
    }));
    assert.equal(plan.kind, "blocked");
  });

  test("greeting / short acknowledgement never creates or suggests an order", () => {
    for (const text of ["hola", "okis", "gracias", "👍"]) {
      const plan = planOrderCreation(facts({
        turnText: text,
        explicitItems: [{ name: "Genesis", quantity: 1 }],
      }));
      assert.equal(plan.kind, "blocked", `expected blocked: ${text}`);
      if (plan.kind === "blocked") {
        assert.match(plan.message, /No sugieras "lo de siempre"|NO se creó ningún pedido/);
      }
    }
  });

  test("reply to a closure/status notification never creates an order", () => {
    const plan = planOrderCreation(facts({
      turnText: "dale",
      replyToNotification: true,
      sameDayCartItems: [{ name: "Genesis", quantity: 1 }],
    }));
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.equal(plan.reason, "notification_reply");
  });

  test("a valid same-day explicit order is created", () => {
    const direct = planOrderCreation(facts({
      turnText: "quiero 2 Deli Deli",
      explicitItems: [{ name: "Deli Deli", quantity: 2 }],
    }));
    assert.equal(direct.kind, "create");
    if (direct.kind === "create") {
      assert.deepEqual(direct.items, [{ name: "Deli Deli", quantity: 2 }]);
    }

    // The server cart is the chosen source of truth for an explicit order turn.
    const fromCart = planOrderCreation(facts({
      turnText: "quiero 2 deli deli",
      sameDayCartItems: [{ name: "Deli Deli", quantity: 2 }],
    }));
    assert.equal(fromCart.kind, "create");
    if (fromCart.kind === "create") {
      assert.deepEqual(fromCart.items, [{ name: "Deli Deli", quantity: 2 }]);
    }
  });

  test("no explicit current-day items is blocked", () => {
    const plan = planOrderCreation(facts({ turnText: "hola, ¿cómo va todo?" }));
    assert.equal(plan.kind, "blocked");
  });

  test("an ambiguous short reply is not an order", () => {
    const plan = planOrderCreation(facts({
      turnText: "todo bien?",
      explicitItems: [{ name: "Genesis", quantity: 1 }],
    }));
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.equal(plan.reason, "not_an_order");
  });

  test("items the current turn never mentioned are rejected", () => {
    const plan = planOrderCreation(facts({
      turnText: "quiero algo",
      explicitItems: [{ name: "Genesis", quantity: 1 }],
    }));
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.equal(plan.reason, "unsupported_items");
  });

  test("cart-present greetings/acks never create an order", () => {
    for (const text of ["hola", "ok"]) {
      const plan = planOrderCreation(facts({
        turnText: text,
        sameDayCartItems: [{ name: "Deli Deli", quantity: 2 }],
      }));
      assert.equal(plan.kind, "blocked", `expected blocked: ${text}`);
      if (plan.kind === "blocked") assert.equal(plan.reason, "non_ordering");
    }
  });

  test("cart-present unmentioned explicitItems are rejected, not merged", () => {
    const plan = planOrderCreation(facts({
      turnText: "quiero lo de siempre",
      sameDayCartItems: [{ name: "Deli Deli", quantity: 2 }],
      explicitItems: [{ name: "Genesis", quantity: 1 }],
    }));
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.equal(plan.reason, "unsupported_items");
  });
});

describe("4-hour active-order lifecycle", () => {
  const now = new Date("2026-10-13T18:00:00Z");

  test("open order under 4h is kept active and asks same-or-new", () => {
    const activeOrder = { id: 248, status: "pending", createdAt: new Date(now.getTime() - 1 * HOUR) };
    assert.deepEqual(evaluateOrderLifecycle({ activeOrder, now }), {
      action: "keep_active",
      orderId: 248,
      ageHours: 1,
    });

    const plan = planOrderCreation(facts({
      now,
      turnText: "quiero 2 Deli Deli",
      explicitItems: [{ name: "Deli Deli", quantity: 2 }],
      activeOrder,
    }));
    assert.equal(plan.kind, "keep_active");
    if (plan.kind === "keep_active") assert.match(plan.message, /mismo pedido o querés uno nuevo/);
  });

  test("explicit 'otro pedido' intent proceeds past keep_active", () => {
    const activeOrder = { id: 248, status: "pending", createdAt: new Date(now.getTime() - 1 * HOUR) };
    const plan = planOrderCreation(facts({
      now,
      turnText: "quiero otro pedido: 2 genesis",
      explicitItems: [{ name: "Genesis", quantity: 2 }],
      activeOrder,
    }));
    assert.equal(plan.kind, "create");
  });

  test("a pending same/new clarification lets the follow-up order through", () => {
    const activeOrder = { id: 248, status: "pending", createdAt: new Date(now.getTime() - 1 * HOUR) };
    const plan = planOrderCreation(facts({
      now,
      turnText: "2 genesis",
      explicitItems: [{ name: "Genesis", quantity: 2 }],
      activeOrder,
      newOrderIntentPending: true,
    }));
    assert.equal(plan.kind, "create");
  });

  test("without a new-order intent, keep_active still asks first", () => {
    const activeOrder = { id: 248, status: "pending", createdAt: new Date(now.getTime() - 1 * HOUR) };
    const plan = planOrderCreation(facts({
      now,
      turnText: "2 genesis",
      explicitItems: [{ name: "Genesis", quantity: 2 }],
      activeOrder,
    }));
    assert.equal(plan.kind, "keep_active");
    if (plan.kind === "keep_active") assert.match(plan.message, new RegExp(KEEP_ACTIVE_ORDER_MARKER));
  });

  test("separate-order phrasing is detected without matching plain items", () => {
    assert.equal(wantsSeparateOrder("quiero otro pedido"), true);
    assert.equal(wantsSeparateOrder("haceme un pedido aparte"), true);
    assert.equal(wantsSeparateOrder("2 genesis"), false);
    assert.equal(wantsSeparateOrder("dame otro"), false);
  });

  test("stale open order at/over 4h is auto-closed before creating", () => {
    const atBoundary = { id: 249, status: "pending", createdAt: new Date(now.getTime() - 4 * HOUR) };
    const lifecycle = evaluateOrderLifecycle({ activeOrder: atBoundary, now });
    assert.equal(lifecycle.action, "auto_close");

    const plan = planOrderCreation(facts({
      now,
      turnText: "quiero 1 Genesis",
      explicitItems: [{ name: "Genesis", quantity: 1 }],
      activeOrder: atBoundary,
    }));
    assert.equal(plan.kind, "auto_close_then_create");
    if (plan.kind === "auto_close_then_create") assert.equal(plan.closeOrderId, 249);
  });

  test("hour window wins over a calendar-day boundary", () => {
    // now = 13/10 00:30 AR; order created 12/10 23:30 AR (1h ago) → still active.
    const localNow = new Date("2026-10-13T03:30:00Z");
    const activeOrder = { id: 250, status: "preparing", createdAt: new Date("2026-10-13T02:30:00Z") };
    const lifecycle = evaluateOrderLifecycle({ activeOrder, now: localNow });
    assert.equal(lifecycle.action, "keep_active");
  });

  test("stale close is idempotent and conditional", async () => {
    const lifecycleRepository: OrderLifecycleRepository = {
      async findActiveOrder() {
        return { id: 251, status: "pending", createdAt: new Date(now.getTime() - 5 * HOUR) };
      },
      async closeOrderAsDeliveredPaid(orderId: number, at: Date) {
        void orderId;
        void at;
        return true; // first caller transitioned the row
      },
    };
    let closeCalls = 0;
    const counting: OrderLifecycleRepository = {
      ...lifecycleRepository,
      async closeOrderAsDeliveredPaid(orderId, at) {
        closeCalls += 1;
        void orderId;
        void at;
        // Only the first call transitions; later calls are no-ops.
        return closeCalls === 1;
      },
    };

    const order = { id: 251, status: "pending", createdAt: new Date(now.getTime() - 5 * HOUR) };
    const first = await autoCloseStaleOrder(order, now, counting);
    const second = await autoCloseStaleOrder(order, now, counting);

    assert.equal(first.closed, true);
    assert.equal(second.closed, false, "a repeated close must be an idempotent no-op");
    assert.equal(closeCalls, 2, "close is attempted but only the first transitions");
    assert.equal(first.orderId, 251);
  });
});

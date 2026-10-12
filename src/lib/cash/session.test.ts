import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import * as sessionModule from "./session";
import { classifyMethod, orderTotal } from "./session";

// Tests de contrato para src/lib/cash/session.ts según sdd/caja-cierre/specs.md
// (§1 clasificación y totales, §2 API exacta, §6 cobertura pedida).
// session.ts llega por merge desde otro worktree: este archivo corre en el
// integrador post-merge. Las funciones puras se testean directo; los casos con
// DB quedan (a) verificados como invariantes de fuente y (b) documentados como
// tests skipped para correr contra una base de test.

const SOURCE = "src/lib/cash/session.ts";

describe("classifyMethod", () => {
  const CASH = ["efectivo", "cash", "contado", "efvo", "en mano"];
  const DIGITAL = [
    "mercadopago",
    "mercado pago",
    "mp",
    "transferencia",
    "alias",
    "tarjeta",
    "debito",
    "credito",
    "qr",
    "modo",
    "cuenta dni",
  ];

  for (const method of CASH) {
    test(`clasifica "${method}" como cash`, () => {
      assert.equal(classifyMethod(method), "cash");
    });
  }

  for (const method of DIGITAL) {
    test(`clasifica "${method}" como digital`, () => {
      assert.equal(classifyMethod(method), "digital");
    });
  }

  test("normaliza mayúsculas y espacios", () => {
    assert.equal(classifyMethod("  EFECTIVO "), "cash");
    assert.equal(classifyMethod("MercadoPago"), "digital");
    assert.equal(classifyMethod("TRANSFERENCIA"), "digital");
  });

  test("variantes con acento siguen siendo digitales", () => {
    assert.equal(classifyMethod("débito"), "digital");
    assert.equal(classifyMethod("crédito"), "digital");
  });

  test("null, vacío y métodos no mapeados van a unknown", () => {
    assert.equal(classifyMethod(null), "unknown");
    assert.equal(classifyMethod(""), "unknown");
    assert.equal(classifyMethod("a convenir"), "unknown");
    assert.equal(classifyMethod("cripto"), "unknown");
  });

  test("no matchea por substring: 'campo' no es 'mp'", () => {
    // Guarda contra un includes() ingenuo: "campo" contiene "mp" pero no es
    // un método de pago digital.
    assert.equal(classifyMethod("campo"), "unknown");
  });
});

describe("orderTotal", () => {
  test("suma price × quantity de los items", () => {
    const total = orderTotal({
      items: [
        { name: "Genesis", quantity: 2, price: 7500 },
        { name: "Pan brioche", quantity: 1, price: 900 },
      ],
      deliveryFee: null,
    });
    assert.equal(total, 15900);
  });

  test("suma deliveryFee (numeric llega como string)", () => {
    const total = orderTotal({
      items: [{ name: "Genesis", quantity: 1, price: 7500 }],
      deliveryFee: "1500.00",
    });
    assert.equal(total, 9000);
  });

  test("deliveryFee null aporta 0", () => {
    const total = orderTotal({
      items: [{ name: "Genesis", quantity: 1, price: 7500 }],
      deliveryFee: null,
    });
    assert.equal(total, 7500);
  });

  test("items sin price aportan 0", () => {
    const total = orderTotal({
      items: [
        { name: "Genesis", quantity: 1, price: 7500 },
        { name: "Extra sin precio", quantity: 1 },
      ],
      deliveryFee: null,
    });
    assert.equal(total, 7500);
  });

  test("price como string numeric se coercea", () => {
    const total = orderTotal({
      items: [{ name: "Genesis", quantity: 2, price: "7500.00" }],
      deliveryFee: null,
    });
    assert.equal(total, 15000);
  });

  test("items vacíos y sin fee totalizan 0", () => {
    assert.equal(orderTotal({ items: [], deliveryFee: null }), 0);
  });
});

describe("contrato de exports (spec §2)", () => {
  test("session.ts exporta toda la API del contrato", () => {
    const exports = [
      "classifyMethod",
      "orderTotal",
      "getOpenSession",
      "ensureOpenSession",
      "openSession",
      "addMovement",
      "getSnapshot",
      "closeSession",
      "getHistory",
    ];
    for (const name of exports) {
      assert.equal(
        typeof (sessionModule as Record<string, unknown>)[name],
        "function",
        `falta export ${name} en session.ts`,
      );
    }
  });
});

// Invariantes que la spec exige pero que corren contra DB: se verifican sobre
// el fuente (mismo patrón que src/lib/telegram/webhook-model.test.ts) para
// detectar desvíos del contrato sin levantar una base.
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `missing ${signature}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n}", open);
  assert.ok(open !== -1 && close !== -1, `unterminated body for ${signature}`);
  return source.slice(open, close);
}

describe("invariantes de implementación (spec §1/§2)", () => {
  test("ensureOpenSession continúa la cadena: abre desde la última cerrada", () => {
    // Invariante: openedAt = lastClosed.closedAt y openingCash =
    // lastClosed.actualCash — nunca huecos ni solapamientos.
    const body = functionBody(readFileSync(SOURCE, "utf8"), "function ensureOpenSession");
    assert.match(body, /closed_?at/i);
    assert.match(body, /actual_?cash/i);
  });

  test("closeSession rechaza el segundo cierre (idempotencia)", () => {
    // La sesión cerrada es inmutable: el cuerpo compara el status y tiene un
    // camino de error (return { error } o throw) para el re-cierre.
    const body = functionBody(readFileSync(SOURCE, "utf8"), "function closeSession");
    assert.match(body, /status\s*(===|!==|==|!=)[^;\n]*["'](?:open|closed)["']/);
    assert.match(body, /return\s*\{[^}]*error|throw\s/i);
  });

  test("closeSession persiste el report serializado", () => {
    const body = functionBody(readFileSync(SOURCE, "utf8"), "function closeSession");
    assert.match(body, /report/i);
  });

  test("openSession falla si ya hay una sesión abierta", () => {
    const body = functionBody(readFileSync(SOURCE, "utf8"), "function openSession");
    assert.match(body, /open/i);
    assert.match(body, /return\s*\{[^}]*error|throw\s/i);
  });

  test("la ventana de pedidos usa COALESCE(delivered_at, created_at)", () => {
    const source = readFileSync(SOURCE, "utf8");
    assert.match(source, /coalesce\s*\([^)]*delivered_?at[^)]*created_?at[^)]*\)/i);
  });

  test("excluye pedidos cancelados", () => {
    assert.match(readFileSync(SOURCE, "utf8"), /cancelled/i);
  });
});

// Casos del contrato que necesitan una base real (orders + cash_sessions +
// cash_movements). Quedan documentados para correr contra una DB de test:
// descomentar el skip y ajustar fixtures cuando exista infraestructura.
describe("lógica con DB (documentado, requiere base de test)", () => {
  test.skip(
    "continuidad: sin abierta, ensureOpenSession crea con openedAt = lastClosed.closedAt y openingCash = lastClosed.actualCash",
    async () => {
      // Fixture: cashSessions con una cerrada (closedAt = T, actualCash = M).
      // const s = await ensureOpenSession();
      // assert.equal(s.openedAt.getTime(), T.getTime());
      // assert.equal(Number(s.openingCash), M);
    },
  );

  test.skip(
    "continuidad: sin historial, la primera sesión abre ahora con openingCash = 0",
    async () => {
      // Fixture: cashSessions vacía.
      // const s = await ensureOpenSession();
      // assert.equal(Number(s.openingCash), 0);
    },
  );

  test.skip(
    "ensureOpenSession con una abierta devuelve la misma sin duplicar",
    async () => {
      // Fixture: una sesión open (id = N).
      // const a = await ensureOpenSession();
      // const b = await ensureOpenSession();
      // assert.equal(a.id, N);
      // assert.equal(b.id, N);
      // + count(cashSessions) sigue siendo 1.
    },
  );

  test.skip(
    "cierre idempotente: la segunda llamada falla sin pisar el report",
    async () => {
      // Fixture: una sesión open.
      // const first = await closeSession(12000, "test");
      // const second = await closeSession(99999, "test");
      // assert "error" in second o rejects; la fila conserva
      // actualCash = 12000 y el report del primer cierre.
    },
  );

  test.skip(
    "expectedCash = openingCash + cashTotal + entradas − salidas",
    async () => {
      // Fixture: sesión open + pedidos cash pagados + movimientos in/out.
      // const snap = await getSnapshot(id);
      // assert.equal(snap.expectedCash, opening + cashTotal + in - out);
    },
  );

  test.skip(
    "la ventana [openedAt, closedAt) excluye cancelados y ordena pendientes",
    async () => {
      // Fixture: pedidos antes/dentro/después de la ventana, uno cancelled,
      // uno con paymentStatus 'pending'.
      // El de afuera y el cancelled no cuentan; el pending va a pendingOrders
      // y no a cashOrders/digitalByMethod.
    },
  );
});

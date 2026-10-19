import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isAllowedCheckoutOrigin } from "./origin";

const ENV_KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "NEXTAUTH_URL",
  "RENDER_EXTERNAL_URL",
] as const;

let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  saved = {} as typeof saved;
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isAllowedCheckoutOrigin", () => {
  it("accepts the public origin Render injects via RENDER_EXTERNAL_URL", () => {
    process.env.RENDER_EXTERNAL_URL = "https://muzapp.onrender.com";
    const request = new Request("http://127.0.0.1:3000/api/checkout", {
      headers: {
        origin: "https://muzapp.onrender.com",
        "x-forwarded-host": "muzapp.onrender.com",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(isAllowedCheckoutOrigin(request), true);
  });

  it("accepts a configured custom domain", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://tienda.example.com";
    const request = new Request("http://127.0.0.1:3000/api/checkout", {
      headers: {
        origin: "https://tienda.example.com",
        "x-forwarded-host": "tienda.example.com",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(isAllowedCheckoutOrigin(request), true);
  });

  it("rejects an origin different from the configured public host", () => {
    process.env.RENDER_EXTERNAL_URL = "https://muzapp.onrender.com";
    const request = new Request("http://127.0.0.1:3000/api/checkout", {
      headers: {
        origin: "https://attacker.example",
        "x-forwarded-host": "muzapp.onrender.com",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(isAllowedCheckoutOrigin(request), false);
  });

  it("fails closed on a client-supplied forwarded host when no origin is configured", () => {
    // No NEXT_PUBLIC_APP_URL/NEXTAUTH_URL/RENDER_EXTERNAL_URL — a spoofed
    // x-forwarded-host must NOT be enough to legitimize an origin.
    const request = new Request("http://127.0.0.1:3000/api/checkout", {
      headers: {
        origin: "https://attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(isAllowedCheckoutOrigin(request), false);
  });

  it("rejects a spoofed forwarded host even when a real public origin exists", () => {
    process.env.RENDER_EXTERNAL_URL = "https://muzapp.onrender.com";
    const request = new Request("http://127.0.0.1:3000/api/checkout", {
      headers: {
        origin: "https://attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(isAllowedCheckoutOrigin(request), false);
  });

  it("still accepts a same-origin request with nothing configured", () => {
    const request = new Request("http://127.0.0.1:3000/api/checkout", {
      headers: { origin: "http://127.0.0.1:3000" },
    });
    assert.equal(isAllowedCheckoutOrigin(request), true);
  });
});

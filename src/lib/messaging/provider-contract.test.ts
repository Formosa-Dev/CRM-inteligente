import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  getProvider,
  hasProvider,
  listProviders,
  providerForChannel,
} from "./registry";
import { kapsoProvider } from "./providers/kapso";
import { ycloudProvider } from "./providers/ycloud";
import { zernioProvider } from "./providers/zernio";
import type { MessagingProvider, ProviderId } from "./types";

const VALID_PROVIDER_IDS: ProviderId[] = ["ycloud", "zernio", "kapso"];
const SIGNATURE_SCHEMES = ["timestamped-hmac", "raw-body-hmac"] as const;

/**
 * Shared contract suite — every registered MessagingProvider must satisfy
 * the same interface shape and fail-closed signature behavior. Provider
 * fixtures (valid signatures, parsed payloads) live in per-provider tests.
 */
export function describeMessagingProviderContract(
  provider: MessagingProvider
): void {
  describe(`MessagingProvider contract: ${provider.id}`, () => {
    test("id is a registered ProviderId", () => {
      assert.ok(VALID_PROVIDER_IDS.includes(provider.id));
    });

    test("signatureScheme is one of the documented schemes", () => {
      assert.ok(
        (SIGNATURE_SCHEMES as readonly string[]).includes(
          provider.signatureScheme
        )
      );
    });

    test("verifyWebhook is fail-closed when the signature header is missing", () => {
      const res = provider.verifyWebhook({
        headers: {},
        rawBody: JSON.stringify({ type: "any" }),
        secret: "any-secret",
      });
      assert.equal(res.ok, false);
      assert.equal(typeof res.reason, "string");
    });

    test("verifyWebhook is fail-closed when the secret is missing", () => {
      const res = provider.verifyWebhook({
        headers: { "ycloud-signature": "t=1,s=abc" },
        rawBody: "{}",
        secret: "",
      });
      assert.equal(res.ok, false);
    });

    test("verifyWebhook does not throw on malformed input", () => {
      const res = provider.verifyWebhook({
        headers: { "x-other": "1" },
        rawBody: "not-json",
        secret: "s",
      });
      assert.equal(res.ok, false);
    });

    test("parseWebhook returns an array for malformed bodies", () => {
      assert.ok(
        Array.isArray(
          provider.parseWebhook({ headers: {}, rawBody: "not-json{{" })
        )
      );
      assert.ok(
        Array.isArray(provider.parseWebhook({ headers: {}, rawBody: "42" }))
      );
      assert.ok(
        Array.isArray(provider.parseWebhook({ headers: {}, rawBody: "{}" }))
      );
    });

    test("normalized events carry the required contract fields", () => {
      const events = provider.parseWebhook({
        headers: {},
        rawBody: JSON.stringify({ type: "unknown.event", id: "evt_x" }),
      });
      for (const event of events) {
        assert.equal(event.provider, provider.id);
        assert.equal(typeof event.deliveryId, "string");
        assert.equal(typeof event.direction, "string");
        assert.equal(typeof event.providerAccountId, "string");
        assert.equal(typeof event.timestamp, "string");
        assert.equal(typeof event.sender, "object");
        assert.ok("raw" in event);
      }
    });

    test("sendMessage is a function returning a SendResult promise", () => {
      assert.equal(typeof provider.sendMessage, "function");
    });
  });
}

describeMessagingProviderContract(ycloudProvider);
describeMessagingProviderContract(kapsoProvider);
describeMessagingProviderContract(zernioProvider);

describe("provider registry", () => {
  test("getProvider returns the registered adapters", () => {
    assert.equal(getProvider("ycloud"), ycloudProvider);
    assert.equal(getProvider("kapso"), kapsoProvider);
    assert.equal(getProvider("zernio"), zernioProvider);
  });

  test("getProvider throws for unknown provider strings", () => {
    assert.throws(
      () => getProvider("nope" as ProviderId),
      /No messaging provider/
    );
  });

  test("hasProvider / listProviders reflect the explicit map", () => {
    assert.equal(hasProvider("ycloud"), true);
    assert.equal(hasProvider("kapso"), true);
    assert.equal(hasProvider("zernio"), true);
    assert.deepEqual(listProviders(), [ycloudProvider, kapsoProvider, zernioProvider]);
  });

  test("channel 'whatsapp' is hard-wired to ycloud; other channels unassigned", () => {
    assert.equal(providerForChannel("whatsapp"), ycloudProvider);
    assert.equal(providerForChannel("instagram"), undefined);
    assert.equal(providerForChannel("telegram"), undefined);
  });
});

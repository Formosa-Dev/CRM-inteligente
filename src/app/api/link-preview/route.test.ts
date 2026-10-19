import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPrivateIp } from "./helpers";

describe("link-preview SSRF guard — isPrivateIp", () => {
  it("blocks every IPv4 private range", () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.1",
      "100.64.0.1", // CGNAT
      "100.127.9.9",
      "224.0.0.1", // multicast
      "255.255.255.255",
    ]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
  });

  it("blocks IPv4-mapped IPv6 forms that used to slip through", () => {
    assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);
    assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateIp("[::ffff:192.168.1.1]"), true);
    assert.equal(isPrivateIp("::ffff:8.8.8.8"), false); // mapped PUBLIC stays usable
  });

  it("blocks IPv6 loopback, unspecified, link-local, ULA and multicast", () => {
    for (const ip of [
      "::",
      "::1",
      "[::1]",
      "fe80::1",
      "fea0::1234",
      "fc00::1",
      "fd00::1",
      "ff02::1",
      "::ffff:a00:1", // hex-tail mapped form
    ]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
  });

  it("allows normal public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1",
      "100.63.0.1",
      "192.169.0.1",
      "2606:4700:4700::1111",
    ]) {
      assert.equal(isPrivateIp(ip), false, ip);
    }
  });
});

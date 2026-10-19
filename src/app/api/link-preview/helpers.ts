// Loopback, RFC1918, link-local, CGNAT (100.64/10), unspecified/broadcast
// and multicast/reserved space.
const PRIVATE_V4 =
  /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^2([2-9][4-9]|[3-5]\d)\./;

export function isPrivateIp(ip: string): boolean {
  let v = ip.trim().toLowerCase();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  // IPv4-mapped IPv6 (::ffff:1.2.3.4 / [::ffff:1.2.3.4]) — evaluate the
  // embedded IPv4 against the same ranges instead of missing it entirely.
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) v = mapped[1];
  else if (v.includes(":")) {
    // IPv6: unspecified (::), loopback (::1), link-local fe80::/10,
    // ULA fc00::/7, multicast ff00::/8 and any leftover mapped/hex form.
    return (
      v === "::" ||
      v === "::1" ||
      /^fe[89ab]/.test(v) ||
      /^f[cd]/.test(v) ||
      v.startsWith("ff") ||
      v.startsWith("::ffff:")
    );
  }
  return PRIVATE_V4.test(v);
}

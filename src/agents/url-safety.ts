// SSRF-safe URL validation for the Evidence Scout. See docs/ARCHITECTURE.md §1 ("Bounded investigation loop").
//
// The platform `URL` parser already canonicalises decimal/hex/octal IPv4 host forms
// (e.g. "2130706433" or "0x7f000001" both become "127.0.0.1") and IPv4-mapped IPv6
// literals into hex groups, so this module only has to classify the parser's output.
//
// Known limitation: this module validates the literal host in the URL only. It deliberately does
// not resolve hostnames via DNS (e.g. DNS-over-HTTPS) to check where they actually point, so a
// public hostname that resolves to a private/loopback address at fetch time (DNS rebinding) is
// not caught here. `fetch()` runs from the Workers runtime, whose egress network already can't
// reach RFC1918/loopback/link-local ranges, which mitigates the residual risk.

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

type HostCheck = { ok: true } | { ok: false; reason: string };

/** Validates a user- or page-supplied URL against SSRF and scope rules. Never throws. */
export function validatePublicUrl(input: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(String(input).trim());
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Only http and https links are supported (got "${url.protocol.replace(":", "")}").` };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed." };
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: `Port ${url.port} is not allowed.` };
  }

  const hostCheck = checkHostname(url.hostname);
  if (!hostCheck.ok) return hostCheck;

  url.hash = ""; // fragments never change what is fetched; strip them
  return { ok: true, url };
}

function checkHostname(hostnameRaw: string): HostCheck {
  // Strip a trailing FQDN root dot ("localhost." is the same host as "localhost") before any
  // suffix/equality checks below, otherwise it silently bypasses them.
  const hostname = hostnameRaw.toLowerCase().replace(/\.+$/, "");

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return checkIPv6Literal(hostname.slice(1, -1));
  }

  if (isDottedIPv4(hostname)) {
    const octets = hostname.split(".").map(Number) as [number, number, number, number];
    return checkIPv4(octets);
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "localhost addresses are not public." };
  }
  if (hostname.endsWith(".local")) {
    return { ok: false, reason: '".local" addresses are not public.' };
  }
  if (hostname.endsWith(".internal")) {
    return { ok: false, reason: '".internal" addresses are not public.' };
  }

  return { ok: true };
}

function isDottedIPv4(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && hostname.split(".").every((part) => Number(part) <= 255);
}

function checkIPv4([a, b, c, d]: [number, number, number, number]): HostCheck {
  if (a === 0) return { ok: false, reason: "0.0.0.0/8 addresses are not public." };
  if (a === 127) return { ok: false, reason: "Loopback addresses are not public." };
  if (a === 10) return { ok: false, reason: "Private network addresses (10.0.0.0/8) are not public." };
  if (a === 172 && b >= 16 && b <= 31) {
    return { ok: false, reason: "Private network addresses (172.16.0.0/12) are not public." };
  }
  if (a === 192 && b === 168) {
    return { ok: false, reason: "Private network addresses (192.168.0.0/16) are not public." };
  }
  if (a === 169 && b === 254) {
    if (c === 169 && d === 254) return { ok: false, reason: "Cloud metadata addresses are not public." };
    return { ok: false, reason: "Link-local addresses (169.254.0.0/16) are not public." };
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return { ok: false, reason: "Shared address space / CGNAT (100.64.0.0/10) addresses are not public." };
  }
  if (a === 192 && b === 0 && c === 0) {
    return { ok: false, reason: "IETF protocol assignment addresses (192.0.0.0/24) are not public." };
  }
  if (a === 192 && b === 88 && c === 99) {
    return { ok: false, reason: "6to4 relay anycast addresses (192.88.99.0/24) are not public." };
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return { ok: false, reason: "Benchmarking addresses (198.18.0.0/15) are not public." };
  }
  if (a >= 224) {
    // Covers multicast (224.0.0.0/4) and reserved-for-future-use (240.0.0.0/4), including broadcast.
    return { ok: false, reason: "Multicast or reserved addresses are not public." };
  }
  return { ok: true };
}

/** Expands a bracket-free IPv6 literal into 8 16-bit groups, or null if unparseable. */
function expandIPv6(addrIn: string): number[] | null {
  let addr = addrIn;

  // Defensive: handle a dotted IPv4 tail (e.g. "::ffff:127.0.0.1"). The WHATWG URL
  // parser normally rewrites this to hex groups already, but don't rely on that.
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4part = addr.slice(lastColon + 1);
    if (!isDottedIPv4(v4part)) return null;
    const [a, b, c, d] = v4part.split(".").map(Number);
    const hexGroups = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    addr = addr.slice(0, lastColon) + ":" + hexGroups;
  }

  const parts = addr.split("::");
  if (parts.length > 2) return null;

  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];

  let groups: string[];
  if (parts.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }

  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === "" ? 0 : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function checkIPv6Literal(addr: string): HostCheck {
  const groups = expandIPv6(addr);
  if (!groups) return { ok: false, reason: "Could not parse IPv6 address." };
  return checkIPv6Groups(groups);
}

function checkIPv6Groups(g: number[]): HostCheck {
  const allZero = g.every((n) => n === 0);
  if (allZero) return { ok: false, reason: "The unspecified IPv6 address is not public." };

  const isLoopback = g.slice(0, 7).every((n) => n === 0) && g[7] === 1;
  if (isLoopback) return { ok: false, reason: "Loopback addresses are not public." };

  if ((g[0] & 0xfe00) === 0xfc00) {
    return { ok: false, reason: "Unique local addresses (fc00::/7) are not public." };
  }
  if ((g[0] & 0xffc0) === 0xfe80) {
    return { ok: false, reason: "Link-local addresses (fe80::/10) are not public." };
  }
  if ((g[0] & 0xff00) === 0xff00) {
    return { ok: false, reason: "Multicast addresses (ff00::/8) are not public." };
  }

  // IPv4-mapped IPv6: ::ffff:0:0/96 — check the embedded IPv4 address too.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const inner = checkIPv4(last32AsIPv4(g));
    if (!inner.ok) return { ok: false, reason: `IPv4-mapped address: ${inner.reason}` };
  }

  // IPv4-compatible IPv6 (deprecated, RFC 4291 historical): ::a.b.c.d/96 — groups 0-5 all zero.
  // Distinct from the mapped form above (which sets group 5 to 0xffff) and from the loopback/
  // unspecified addresses already handled above (which return before reaching this point). This
  // is the form that let "[::127.0.0.1]" (written as "[::7f00:1]") slip past validation.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const inner = checkIPv4(last32AsIPv4(g));
    if (!inner.ok) return { ok: false, reason: `IPv4-compatible address: ${inner.reason}` };
  }

  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address in the last 32 bits.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const inner = checkIPv4(last32AsIPv4(g));
    if (!inner.ok) return { ok: false, reason: `NAT64-embedded address: ${inner.reason}` };
  }

  // 6to4 2002::/16 embeds an IPv4 address in the next 32 bits (groups 1-2).
  if (g[0] === 0x2002) {
    const a = (g[1] >> 8) & 0xff;
    const b = g[1] & 0xff;
    const c = (g[2] >> 8) & 0xff;
    const d = g[2] & 0xff;
    const inner = checkIPv4([a, b, c, d]);
    if (!inner.ok) return { ok: false, reason: `6to4-embedded address: ${inner.reason}` };
  }

  return { ok: true };
}

/** Reads the last 32 bits of an expanded IPv6 address as IPv4 octets. */
function last32AsIPv4(g: number[]): [number, number, number, number] {
  const a = (g[6] >> 8) & 0xff;
  const b = g[6] & 0xff;
  const c = (g[7] >> 8) & 0xff;
  const d = g[7] & 0xff;
  return [a, b, c, d];
}

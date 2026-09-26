import { describe, expect, it } from "vitest";
import { validatePublicUrl } from "../url-safety";

function expectOk(input: string) {
  const result = validatePublicUrl(input);
  expect(result.ok).toBe(true);
  return result;
}

function expectRejected(input: string) {
  const result = validatePublicUrl(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason.length).toBeGreaterThan(0);
  }
  return result;
}

describe("validatePublicUrl", () => {
  it("accepts an ordinary public https URL", () => {
    const result = expectOk("https://www.garnier.pt/");
    if (result.ok) {
      expect(result.url.href).toBe("https://www.garnier.pt/");
    }
  });

  it("accepts http and default/alternate ports", () => {
    expectOk("http://example.com/");
    expectOk("https://example.com:443/");
    expectOk("http://example.com:80/");
    expectOk("https://example.com:8443/path");
    expectOk("http://example.com:8080/path");
  });

  it("strips the fragment from the returned URL", () => {
    const result = expectOk("https://example.com/page#section-2");
    if (result.ok) {
      expect(result.url.hash).toBe("");
      expect(result.url.href).toBe("https://example.com/page");
    }
  });

  it("rejects malformed input", () => {
    expectRejected("not a url");
    expectRejected("");
    expectRejected("   ");
  });

  it("rejects non-http(s) schemes", () => {
    expectRejected("ftp://example.com/file.txt");
    expectRejected("file:///etc/passwd");
    expectRejected("javascript:alert(1)");
    expectRejected("data:text/html,<script>alert(1)</script>");
  });

  it("rejects credentials embedded in the URL", () => {
    expectRejected("https://user:pass@example.com/");
    expectRejected("https://user@example.com/");
  });

  it("rejects odd ports", () => {
    expectRejected("http://example.com:22/");
    expectRejected("https://example.com:8081/");
    expectRejected("http://example.com:3000/");
  });

  it("rejects localhost and reserved TLD-like hostnames", () => {
    expectRejected("http://localhost/");
    expectRejected("http://localhost:8080/");
    expectRejected("http://foo.localhost/");
    expectRejected("http://printer.local/");
    expectRejected("http://service.internal/");
  });

  it("rejects IPv4 loopback, private, link-local, CGNAT, metadata and multicast addresses", () => {
    expectRejected("http://127.0.0.1/");
    expectRejected("http://127.53.0.9/");
    expectRejected("http://10.0.0.5/");
    expectRejected("http://172.16.0.1/");
    expectRejected("http://172.31.255.255/");
    expectRejected("http://192.168.1.1/");
    expectRejected("http://169.254.169.254/"); // cloud metadata
    expectRejected("http://169.254.1.1/"); // general link-local
    expectRejected("http://100.64.0.1/"); // CGNAT
    expectRejected("http://100.100.1.1/"); // CGNAT
    expectRejected("http://0.0.0.0/");
    expectRejected("http://224.0.0.1/"); // multicast
    expectRejected("http://255.255.255.255/"); // broadcast
  });

  it("does not reject IPv4 addresses that are merely adjacent to private ranges", () => {
    expectOk("http://172.32.0.1/"); // just outside 172.16.0.0/12
    expectOk("http://172.15.255.255/");
    expectOk("http://11.0.0.1/");
    expectOk("http://100.63.255.255/"); // just outside CGNAT
    expectOk("http://100.128.0.1/");
  });

  it("rejects decimal and hex encodings of loopback/private IPv4 addresses", () => {
    expectRejected("http://2130706433/"); // 127.0.0.1 as a decimal integer
    expectRejected("http://0x7f000001/"); // 127.0.0.1 as hex
    expectRejected("http://017700000001/"); // 127.0.0.1 as octal
    expectRejected("http://3232235521/"); // 192.168.0.1 as decimal
    expectRejected("http://0xA9FEA9FE/"); // 169.254.169.254 as hex
  });

  it("rejects IPv6 loopback, unique-local, link-local and multicast addresses", () => {
    expectRejected("http://[::1]/");
    expectRejected("http://[fc00::1]/");
    expectRejected("http://[fd12:3456:789a::1]/");
    expectRejected("http://[fe80::1]/");
    expectRejected("http://[ff02::1]/");
    expectRejected("http://[::]/");
  });

  it("rejects IPv4-mapped IPv6 addresses that map to private IPv4 ranges", () => {
    expectRejected("http://[::ffff:127.0.0.1]/");
    expectRejected("http://[::ffff:192.168.1.1]/");
    expectRejected("http://[::ffff:10.0.0.1]/");
  });

  it("accepts a routable IPv6 address", () => {
    expectOk("http://[2001:db8::1]/");
  });
});

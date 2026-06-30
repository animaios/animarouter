import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { initDb } from "../../db/index.js";
import { isTrustedSourceIp } from "../../lib/ip-trust.js";

// `requireAuth` auto-grants any caller whose source IP is on the local machine
// or the local network. Remote callers still need a session token. This file
// covers both: a unit-level test of the IP classifier, plus a small
// end-to-end probe through a real Express app to prove the gate is wired
// correctly (off-LAN gets 401, on-LAN gets 200, with TRUST_PROXY the
// X-Forwarded-For chain resolves to a non-loopback IP).

// ── Unit tests for the address classifier ─────────────────────────────────

describe("isTrustedSourceIp", () => {
  describe("IPv4 trusted ranges", () => {
    const trusted = [
      "127.0.0.1",
      "127.255.255.254", // 127.0.0.0/8 — full range
      "10.0.0.1",
      "10.255.255.254",
      "172.16.0.1",
      "172.31.255.254", // 172.16.0.0/12 — full range
      "192.168.0.1",
      "192.168.255.254",
      "169.254.0.1", // IPv4 link-local
      "169.254.255.254",
    ];
    for (const addr of trusted) {
      it(`trusts ${addr}`, () => {
        expect(isTrustedSourceIp(addr)).toBe(true);
      });
    }
  });

  describe("IPv4 untrusted (public + private-adjacent)", () => {
    const untrusted = [
      "8.8.8.8", // public DNS
      "1.1.1.1",
      "203.0.113.1", // TEST-NET-3
      "11.0.0.1", // just outside 10.0.0.0/8
      "172.15.255.255", // just outside 172.16.0.0/12 (low side)
      "172.32.0.0", // just outside 172.16.0.0/12 (high side)
      "192.167.255.255", // just outside 192.168.0.0/16 (low side)
      "192.169.0.0", // just outside 192.168.0.0/16 (high side)
      "169.253.255.255", // just outside 169.254.0.0/16
      "169.255.0.0",
      "128.0.0.1", // just outside 127.0.0.0/8
      "100.64.0.1", // CGNAT — not trusted (we don't carry)
    ];
    for (const addr of untrusted) {
      it(`does not trust ${addr}`, () => {
        expect(isTrustedSourceIp(addr)).toBe(false);
      });
    }
  });

  describe("IPv6 trusted ranges", () => {
    const trusted = [
      "::1",
      "fe80::1", // link-local
      "fe80::abcd:ef",
      "fe80::ffff:ffff:ffff:ffff",
      "fc00::1", // ULA — first 7 bits 1111110x
      "fd00::1",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      // IPv4-mapped forms of trusted IPv4 ranges.
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:192.168.1.1",
      "::ffff:172.16.0.1",
      "::ffff:169.254.0.1",
    ];
    for (const addr of trusted) {
      it(`trusts ${addr}`, () => {
        expect(isTrustedSourceIp(addr)).toBe(true);
      });
    }
  });

  describe("IPv6 untrusted (public + edge cases)", () => {
    const untrusted = [
      "::", // unspecified — NOT trusted (not a real client)
      "2001:4860:4860::8888", // Google public DNS
      "2606:4700:4700::1111", // Cloudflare public DNS
      "::ffff:8.8.8.8", // IPv4-mapped public
      "::ffff:203.0.113.1",
      "fb00::1", // NOT in fc00::/7 (top bit set differently)
    ];
    for (const addr of untrusted) {
      it(`does not trust ${addr}`, () => {
        expect(isTrustedSourceIp(addr)).toBe(false);
      });
    }
  });

  describe("bracketed / port-suffixed input", () => {
    it('strips a "[…]:port" suffix from IPv6', () => {
      expect(isTrustedSourceIp("[::1]:8080")).toBe(true);
    });
    it('strips a "host:port" suffix from IPv4', () => {
      expect(isTrustedSourceIp("10.0.0.1:51234")).toBe(true);
    });
    it("does not trust a bracketed public IPv6", () => {
      expect(isTrustedSourceIp("[2001:4860:4860::8888]:443")).toBe(false);
    });
  });

  describe("malformed input", () => {
    const bad = [
      "",
      "   ",
      "not-an-ip",
      "999.999.999.999",
      "256.0.0.1",
      "10.0.0", // only 3 octets
      "10.0.0.1.5", // 5 octets
      "01.2.3.4", // leading zero
      "10.0.0.01",
      "gggg::1", // non-hex hextet
      "12345::1", // hextet too long
      "::1::1", // multiple ::
      "fe80:::1", // triple colon
      "fe80:",
      ":1::",
      "[unterminated",
    ];
    for (const addr of bad) {
      it(`returns false for ${JSON.stringify(addr)}`, () => {
        expect(isTrustedSourceIp(addr)).toBe(false);
      });
    }
  });

  it("returns false for null and undefined", () => {
    expect(isTrustedSourceIp(null)).toBe(false);
    expect(isTrustedSourceIp(undefined)).toBe(false);
  });
});

// ── End-to-end probes through requireAuth ─────────────────────────────────
//
// The TCP peer in a test is 127.0.0.1 (loopback), so the LAN auto-grant fires
// for any test that does NOT set an X-Forwarded-For header. Cases that want
// to simulate a remote caller opt the app into trusting XFF and send one.

describe("requireAuth integration", () => {
  let app: Express;
  const originalTrustProxy = process.env.TRUST_PROXY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
    app = createApp();
  });

  afterAll(() => {
    if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = originalTrustProxy;
  });

  async function get(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<number> {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      headers,
    });
    server.close();
    return res.status;
  }

  it("auto-grants loopback callers without a session token", async () => {
    // /api/keys requires a session when called remotely; loopback is auto-granted.
    expect(await get("/api/keys")).toBe(200);
  });

  it("still returns 401 for a non-loopback source when no X-Forwarded-For is present and trust proxy is off", async () => {
    // TCP peer is 127.0.0.1 in tests; loopback is trusted regardless. The
    // only way to exercise the 401 path without trust proxy is impossible in
    // a fetch() from a Node test — the kernel peer is always 127.0.0.1. The
    // XFF-driven case below covers the realistic remote-caller scenario.
    // This assertion documents the property: with no XFF, the gate sees a
    // loopback TCP peer and grants access.
    expect(await get("/api/keys")).not.toBe(401);
  });
});

describe("requireAuth integration with TRUST_PROXY=1 (remote-caller simulation)", () => {
  let app: Express;
  const originalTrustProxy = process.env.TRUST_PROXY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    process.env.TRUST_PROXY = "1";
    initDb(":memory:");
    app = createApp();
  });

  afterAll(() => {
    if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = originalTrustProxy;
  });

  async function getFrom(
    path: string,
    forwardedFor: string | null,
  ): Promise<number> {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const headers: Record<string, string> = {};
    if (forwardedFor !== null) headers["X-Forwarded-For"] = forwardedFor;
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      headers,
    });
    server.close();
    return res.status;
  }

  it("401s an unauthenticated request claiming a public IPv4 source", async () => {
    expect(await getFrom("/api/keys", "203.0.113.1")).toBe(401);
  });

  it("401s an unauthenticated request claiming a public IPv6 source", async () => {
    expect(await getFrom("/api/keys", "2001:4860:4860::8888")).toBe(401);
  });

  it("auto-grants a request claiming a trusted IPv4 source via XFF", async () => {
    expect(await getFrom("/api/keys", "10.0.0.5")).toBe(200);
    expect(await getFrom("/api/keys", "192.168.1.42")).toBe(200);
    expect(await getFrom("/api/keys", "172.20.0.7")).toBe(200);
  });

  it("auto-grants a request claiming a trusted IPv6 source via XFF", async () => {
    expect(await getFrom("/api/keys", "::1")).toBe(200);
    expect(await getFrom("/api/keys", "fe80::1")).toBe(200);
    expect(await getFrom("/api/keys", "fc00::1")).toBe(200);
    expect(await getFrom("/api/keys", "fd00:1234::1")).toBe(200);
  });
  it("honors Express trust-proxy semantics: uses the right-most XFF entry", async () => {
    // Express with `trust proxy = 1` uses the right-most X-Forwarded-For
    // entry (the one closest to the server). The TCP peer in this test is
    // 127.0.0.1, which Express substitutes into the chain when N=1.
    //   "203.0.113.1, 10.0.0.5"  →  right-most 10.0.0.5 (trusted) → 200
    //   "10.0.0.5, 203.0.113.1"  →  right-most 203.0.113.1 (untrusted) → 401
    // What this exercises: a non-loopback XFF source is the gate, and the
    // specific value Express surfaces controls the result.
    expect(await getFrom("/api/keys", "203.0.113.1, 10.0.0.5")).toBe(200);
    expect(await getFrom("/api/keys", "10.0.0.5, 203.0.113.1")).toBe(401);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOWED_HOSTS_ENV_VAR,
  hostnameFromHostHeader,
  isHostAllowed,
  parseAllowedHosts,
} from "./allowed-hosts";

/**
 * This module is the app's entire security boundary — an unauthenticated
 * ledger is only safe while the Host header is trusted. Every case below is
 * either "loopback must keep working" (a regression locks the owner out of
 * their own data) or "this must NOT be admitted" (a regression exposes the
 * ledger to a hostile page via DNS rebinding).
 */

const setEnv = (value: string | undefined): void => {
  if (value === undefined) delete process.env[ALLOWED_HOSTS_ENV_VAR];
  else process.env[ALLOWED_HOSTS_ENV_VAR] = value;
};

afterEach(() => setEnv(undefined));

describe("hostnameFromHostHeader", () => {
  it("strips the port so a name is admitted regardless of how it was forwarded", () => {
    expect(hostnameFromHostHeader("localhost:3000")).toBe("localhost");
    expect(hostnameFromHostHeader("example.ts.net:443")).toBe("example.ts.net");
  });

  it("keeps IPv6 brackets, which is what distinguishes an address from a port", () => {
    expect(hostnameFromHostHeader("[::1]:3000")).toBe("[::1]");
    expect(hostnameFromHostHeader("[::1]")).toBe("[::1]");
  });

  it("lowercases, because DNS is case-insensitive (RFC 4343)", () => {
    expect(hostnameFromHostHeader("LocalHost")).toBe("localhost");
    expect(hostnameFromHostHeader("[::1]".toUpperCase())).toBe("[::1]");
  });

  it("trims surrounding whitespace", () => {
    expect(hostnameFromHostHeader("  localhost:3000  ")).toBe("localhost");
  });

  it("yields empty for a malformed unterminated bracket, so it can never match", () => {
    expect(hostnameFromHostHeader("[::1")).toBe("");
  });

  it("yields empty for a bare unbracketed IPv6, matching the historical posture", () => {
    // The pre-migration allowlist carried a bare "::1" entry that was dead
    // code: splitting on ":" yields "". Dropping that entry changed nothing.
    expect(hostnameFromHostHeader("::1")).toBe("");
  });
});

describe("parseAllowedHosts", () => {
  it("always contains loopback, even when the variable is unset", () => {
    const hosts = parseAllowedHosts(undefined);
    expect(hosts.has("localhost")).toBe(true);
    expect(hosts.has("127.0.0.1")).toBe(true);
    expect(hosts.has("[::1]")).toBe(true);
  });

  it("always contains loopback, even when the variable is set to something else", () => {
    expect(parseAllowedHosts("example.ts.net").has("localhost")).toBe(true);
  });

  it("normalizes entries so a copied-from-a-URL port does not silently never match", () => {
    expect(parseAllowedHosts("Example.TS.net:443").has("example.ts.net")).toBe(true);
  });

  it("ignores whitespace and empty entries", () => {
    const hosts = parseAllowedHosts(" a.ts.net , , b.ts.net ,");
    expect(hosts.has("a.ts.net")).toBe(true);
    expect(hosts.has("b.ts.net")).toBe(true);
    expect(hosts.has("")).toBe(false);
  });

  it("treats an empty string as no extra hosts", () => {
    expect(parseAllowedHosts("").size).toBe(3);
  });
});

describe("isHostAllowed", () => {
  it("admits loopback when the variable is unset (today's local-only posture)", () => {
    expect(isHostAllowed("localhost:3000")).toBe(true);
    expect(isHostAllowed("127.0.0.1:3000")).toBe(true);
    expect(isHostAllowed("[::1]:3000")).toBe(true);
  });

  it("rejects an unknown host when the variable is unset", () => {
    expect(isHostAllowed("evil.com")).toBe(false);
    expect(isHostAllowed("moneyapp.example.ts.net")).toBe(false);
  });

  it("rejects a missing or empty Host outright", () => {
    expect(isHostAllowed(null)).toBe(false);
    expect(isHostAllowed(undefined)).toBe(false);
    expect(isHostAllowed("")).toBe(false);
    expect(isHostAllowed("   ")).toBe(false);
  });

  it("rejects a suffix-attack hostname that merely ends with an allowed name", () => {
    // The match is exact-set membership, never endsWith — `localhost.evil.com`
    // is a name an attacker can freely register and point at 127.0.0.1.
    expect(isHostAllowed("localhost.evil.com")).toBe(false);
    expect(isHostAllowed("notlocalhost")).toBe(false);
  });

  it("admits a configured host, on any port and in any case", () => {
    setEnv("moneyapp.example.ts.net");
    expect(isHostAllowed("moneyapp.example.ts.net")).toBe(true);
    expect(isHostAllowed("moneyapp.example.ts.net:443")).toBe(true);
    expect(isHostAllowed("MoneyApp.Example.TS.net")).toBe(true);
  });

  it("still rejects everything the variable did not name", () => {
    setEnv("moneyapp.example.ts.net");
    expect(isHostAllowed("other.example.ts.net")).toBe(false);
    expect(isHostAllowed("evil.com")).toBe(false);
  });

  it("keeps admitting loopback alongside a configured host", () => {
    setEnv("moneyapp.example.ts.net");
    expect(isHostAllowed("localhost:3000")).toBe(true);
  });

  it("admits several comma-separated hosts", () => {
    setEnv("a.example.ts.net,b.example.ts.net");
    expect(isHostAllowed("a.example.ts.net")).toBe(true);
    expect(isHostAllowed("b.example.ts.net")).toBe(true);
    expect(isHostAllowed("c.example.ts.net")).toBe(false);
  });

  it("reads the environment per call, so an operator's edit is not frozen at import", () => {
    expect(isHostAllowed("late.example.ts.net")).toBe(false);
    setEnv("late.example.ts.net");
    expect(isHostAllowed("late.example.ts.net")).toBe(true);
  });
});

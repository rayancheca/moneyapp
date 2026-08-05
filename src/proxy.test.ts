import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { ALLOWED_HOSTS_ENV_VAR } from "@/lib/allowed-hosts";

import { proxy } from "./proxy";

/**
 * Adapter wiring only — the allowlist matrix lives in
 * `src/lib/allowed-hosts.test.ts`, which is inside the 100%-coverage gate.
 * What is proven here is that the perimeter is actually WIRED: that a rejected
 * host gets a 403 body rather than falling through to the app, and that an
 * admitted one gets the pass-through response Next needs to continue routing.
 */

const request = (host: string | null): NextRequest =>
  new NextRequest("http://example.invalid/transactions", {
    headers: host === null ? {} : { host },
  });

afterEach(() => delete process.env[ALLOWED_HOSTS_ENV_VAR]);

describe("proxy", () => {
  it("passes a loopback request through to the app", () => {
    const response = proxy(request("localhost:3000"));
    expect(response.status).toBe(200);
    // Next's sentinel for "continue routing"; a plain 200 would end the chain.
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("forbids an unknown host", () => {
    const response = proxy(request("evil.com"));
    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("forbids a request that carries no Host header at all", () => {
    expect(proxy(request(null)).status).toBe(403);
  });

  it("passes a host named by MONEYAPP_ALLOWED_HOSTS", () => {
    process.env[ALLOWED_HOSTS_ENV_VAR] = "moneyapp.example.ts.net";
    expect(proxy(request("moneyapp.example.ts.net")).status).toBe(200);
    expect(proxy(request("other.example.ts.net")).status).toBe(403);
  });
});

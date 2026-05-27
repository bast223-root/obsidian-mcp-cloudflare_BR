import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import AuthHandler from "../src/auth/handler";
import { renderConsent } from "../src/auth/consent-page";
import { MAX_FAILURES } from "../src/auth/rate-limit";

describe("renderConsent escaping", () => {
  it("HTML-escapes clientName so an injected tag cannot break out", () => {
    const html = renderConsent({
      clientName: '<img src=x onerror="alert(1)">',
      oauthReqInfo: "abc123",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("HTML-escapes the error message", () => {
    const html = renderConsent({
      clientName: "MCP client",
      oauthReqInfo: "abc123",
      error: "</p><script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("POST /authorize", () => {
  function postAuthorize(password: string, ip: string): Request {
    const encoded = btoa(JSON.stringify({ clientId: "test-client", scope: [] }));
    const body = new URLSearchParams({ password, oauthReqInfo: encoded }).toString();
    return new Request("https://obsv.scriptek.com/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": ip,
      },
      body,
    });
  }

  it("rejects a wrong password with 401 and locked-down security headers", async () => {
    const res = await AuthHandler.fetch(postAuthorize("wrong", "203.0.113.1"), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("throttles brute-force attempts from one IP with 429 after MAX_FAILURES", async () => {
    const ip = "203.0.113.2";
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await AuthHandler.fetch(postAuthorize("wrong", ip), env);
      expect(res.status).toBe(401);
    }
    const limited = await AuthHandler.fetch(postAuthorize("wrong", ip), env);
    expect(limited.status).toBe(429);
  });

  it("fails closed with 503 when AUTH_PASSWORD is below the minimum length", async () => {
    const weakEnv = { ...env, AUTH_PASSWORD: "short" };
    const res = await AuthHandler.fetch(postAuthorize("short", "203.0.113.3"), weakEnv);
    expect(res.status).toBe(503);
  });
});

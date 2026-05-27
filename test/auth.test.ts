import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import AuthHandler from "../src/auth/handler";
import { renderConsent } from "../src/auth/consent-page";
import { MAX_FAILURES } from "../src/auth/rate-limit";
import { signValue } from "../src/upload/tokens";

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
  function buildRequest(password: string, oauthReqInfo: string, ip: string): Request {
    const body = new URLSearchParams({ password, oauthReqInfo }).toString();
    return new Request("https://obsv.scriptek.com/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": ip,
      },
      body,
    });
  }

  // A validly-signed oauthReqInfo blob, as the GET handler would have produced
  // it (HMAC keyed by AUTH_PASSWORD). Required now that POST rejects unsigned
  // blobs as tampered.
  async function postAuthorize(password: string, ip: string): Promise<Request> {
    const signed = await signValue(env.AUTH_PASSWORD, btoa(JSON.stringify({ clientId: "test-client", scope: [] })));
    return buildRequest(password, signed, ip);
  }

  it("rejects a wrong password with 401 and locked-down security headers", async () => {
    const res = await AuthHandler.fetch(await postAuthorize("wrong", "203.0.113.1"), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("rejects a tampered (unsigned) oauthReqInfo blob with 400", async () => {
    const unsigned = btoa(JSON.stringify({ clientId: "attacker-client", scope: [] }));
    const res = await AuthHandler.fetch(buildRequest("wrong", unsigned, "203.0.113.4"), env);
    expect(res.status).toBe(400);
  });

  it("rejects a blob whose payload was modified after signing with 400", async () => {
    const signed = await signValue(env.AUTH_PASSWORD, btoa(JSON.stringify({ clientId: "test-client", scope: [] })));
    // Swap the payload for a different one while keeping the original signature.
    const forgedPayload = btoa(JSON.stringify({ clientId: "attacker-client", scope: [] }));
    const tampered = `${forgedPayload}.${signed.slice(signed.indexOf(".") + 1)}`;
    const res = await AuthHandler.fetch(buildRequest("wrong", tampered, "203.0.113.5"), env);
    expect(res.status).toBe(400);
  });

  it("throttles brute-force attempts from one IP with 429 after MAX_FAILURES", async () => {
    const ip = "203.0.113.2";
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await AuthHandler.fetch(await postAuthorize("wrong", ip), env);
      expect(res.status).toBe(401);
    }
    const limited = await AuthHandler.fetch(await postAuthorize("wrong", ip), env);
    expect(limited.status).toBe(429);
  });

  it("fails closed with 503 when AUTH_PASSWORD is below the minimum length", async () => {
    const weakEnv = { ...env, AUTH_PASSWORD: "short" };
    const res = await AuthHandler.fetch(await postAuthorize("short", "203.0.113.3"), weakEnv);
    expect(res.status).toBe(503);
  });
});

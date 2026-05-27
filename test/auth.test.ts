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
  // By default the csrf form field and cookie match (the valid double-submit
  // pair a real GET would have set). Override `csrf`/`cookieCsrf` to exercise the
  // CSRF failure paths; set `cookieCsrf` to null to omit the cookie entirely.
  function buildRequest(
    password: string,
    oauthReqInfo: string,
    ip: string,
    opts: { csrf?: string; cookieCsrf?: string | null } = {},
  ): Request {
    const csrf = opts.csrf ?? "csrf-token-value";
    const cookieCsrf = opts.cookieCsrf === undefined ? csrf : opts.cookieCsrf;
    const body = new URLSearchParams({ password, oauthReqInfo, csrf }).toString();
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip,
    };
    if (cookieCsrf !== null) headers.cookie = `${"obsv_csrf"}=${cookieCsrf}`;
    return new Request("https://obsv.scriptek.com/authorize", { method: "POST", headers, body });
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

  it("rejects a POST with no CSRF cookie with 403", async () => {
    const signed = await signValue(env.AUTH_PASSWORD, btoa(JSON.stringify({ clientId: "test-client", scope: [] })));
    const res = await AuthHandler.fetch(buildRequest("wrong", signed, "203.0.113.6", { cookieCsrf: null }), env);
    expect(res.status).toBe(403);
  });

  it("rejects a POST whose CSRF field does not match the cookie with 403", async () => {
    const signed = await signValue(env.AUTH_PASSWORD, btoa(JSON.stringify({ clientId: "test-client", scope: [] })));
    const res = await AuthHandler.fetch(
      buildRequest("wrong", signed, "203.0.113.7", { csrf: "field-value", cookieCsrf: "different-cookie-value" }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("issues a fresh CSRF cookie on every consent render", async () => {
    const res = await AuthHandler.fetch(await postAuthorize("wrong", "203.0.113.8"), env);
    expect(res.status).toBe(401);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("obsv_csrf=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
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

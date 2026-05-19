/**
 * Next.js middleware tests.
 *
 * Next middleware is just a function — `(req: NextRequest) => Promise<NextResponse>` —
 * so we construct synthetic `NextRequest` instances and call the
 * middleware directly. No Next.js server needed.
 *
 * Coverage:
 *   - Browser passes through (allow)
 *   - Known bot → 402 with crawler-price + structured body
 *   - Bot allow-list (no offer) → allow
 *   - x-crawlertoll-* headers forwarded downstream
 *   - RSL policy: block / charge / allow paths
 *   - onDecision telemetry
 *   - decisionOverride short-circuits
 */

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { crawlertoll } from "../src/index.js";

function makeRequest(
  path: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(new URL(path, "http://test.example"), {
    method: "GET",
    headers,
  });
}

describe("@crawlertoll/next", () => {
  it("passes browser requests through (NextResponse.next())", async () => {
    const mw = crawlertoll({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    const res = await mw(
      makeRequest("/", {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15",
      }),
    );
    expect(res.status).toBe(200);
    // The forwarded request headers carry the decision.
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("returns 402 with crawler-price + structured body to a known bot", async () => {
    const mw = crawlertoll({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      contextLicenseUrl: "https://example.com/.well-known/context-license.json",
      termsUrl: "https://example.com/ai-terms",
    });
    const res = await mw(
      makeRequest("/articles/1", { "user-agent": "GPTBot/1.2" }),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get("crawler-price")).toBe("5000 micros USD");
    expect(res.headers.get("crawler-price-rail")).toBe("x402");
    const linkHeader = res.headers.get("link") ?? "";
    expect(linkHeader).toContain('rel="describedby"');
    expect(linkHeader).toContain('rel="terms-of-service"');
    expect(res.headers.get("x-crawlertoll-action")).toBe("402");
    expect(res.headers.get("x-crawlertoll-operator")).toBe("OpenAI");
    expect(res.headers.get("x-crawlertoll-bot-name")).toBe("GPTBot");

    const body = (await res.json()) as {
      error: string;
      offer: { rail: string; priceMicros: number };
    };
    expect(body.error).toBe("payment_required");
    expect(body.offer.priceMicros).toBe(5000);
  });

  it("allows bots when no offer is configured (default-allow)", async () => {
    const mw = crawlertoll({});
    const res = await mw(
      makeRequest("/", { "user-agent": "ClaudeBot/2.0" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-crawlertoll-action")).toBe("allow");
  });

  it("stamps x-crawlertoll-* headers on allow responses", async () => {
    const mw = crawlertoll({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    const res = await mw(
      makeRequest("/", {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-crawlertoll-action")).toBe("allow");
    expect(res.headers.get("x-crawlertoll-operator")).toBe("");
    expect(res.headers.get("x-crawlertoll-bot-name")).toBe("");
    expect(res.headers.get("x-crawlertoll-verified")).toBe("");
  });

  it("respects RSL policy passed inline as robots.txt text", async () => {
    const policy = `
User-agent: GPTBot
Disallow: /
Allow: /public

User-agent: *
Disallow:
`;
    const mw = crawlertoll({
      policy,
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });

    const blocked = await mw(
      makeRequest("/articles/1", { "user-agent": "GPTBot/1.2" }),
    );
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error: string };
    expect(blockedBody.error).toBe("forbidden");
    expect(blocked.headers.get("x-crawlertoll-action")).toBe("block");

    const allowed = await mw(
      makeRequest("/public/x", { "user-agent": "GPTBot/1.2" }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("x-crawlertoll-action")).toBe("allow");
  });

  it("charges (402) when RSL declares per-crawl compensation", async () => {
    const policy = `
User-agent: GPTBot
Disallow: /
Compensation: per-crawl 5000 micros USD
`;
    const mw = crawlertoll({
      policy,
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    const res = await mw(
      makeRequest("/articles/1", { "user-agent": "GPTBot/1.2" }),
    );
    expect(res.status).toBe(402);
  });

  it("calls onDecision telemetry hook for every request", async () => {
    const seen: string[] = [];
    const mw = crawlertoll({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      onDecision: (decision) => {
        seen.push(decision.action);
      },
    });
    await mw(makeRequest("/", { "user-agent": "GPTBot/1.2" }));
    await mw(
      makeRequest("/", {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2)",
      }),
    );
    // Best-effort hook — give the microtask a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["402", "allow"]);
  });

  it("decisionOverride can short-circuit the decision", async () => {
    const mw = crawlertoll({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      decisionOverride: () => ({
        action: "allow",
        bot: {
          isBot: true,
          entry: null,
          userAgent: "test",
          hasSignatureHeaders: false,
          signatureAgent: null,
          reasons: Object.freeze(["override"]),
        },
        reasons: Object.freeze(["override"]),
      }),
    });
    const res = await mw(
      makeRequest("/", { "user-agent": "GPTBot/1.2" }),
    );
    // Without override this would be 402.
    expect(res.status).toBe(200);
  });

  it("forwardDecisionHeaders: false suppresses x-crawlertoll-* on allow", async () => {
    const mw = crawlertoll({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      forwardDecisionHeaders: false,
    });
    const res = await mw(
      makeRequest("/", {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-crawlertoll-action")).toBeNull();
  });
});

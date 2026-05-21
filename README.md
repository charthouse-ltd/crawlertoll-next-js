# @crawlertoll/next

Next.js middleware for the AI-crawler economy. One-line install in `middleware.ts` — detects AI crawlers, verifies Web Bot Auth, applies RSL 1.0 policy, and issues HTTP 402 with a structured payment offer at the Vercel Edge.

- **License**: Apache-2.0
- **Next.js**: 14.x or 15.x (peer dependency)
- **Runtime**: Edge or Node (Next middleware runs on Edge by default)
- **Core**: [`@crawlertoll/core`](https://www.npmjs.com/package/@crawlertoll/core) — all the standards work happens there; this package is the thin Next bridge.

[![npm](https://img.shields.io/npm/v/%40crawlertoll%2Fnext.svg)](https://www.npmjs.com/package/@crawlertoll/next)
[![license](https://img.shields.io/npm/l/%40crawlertoll%2Fnext.svg)](./LICENSE)

---

## Install

```bash
npm install @crawlertoll/next @crawlertoll/core
```

`next` is a peer dependency — already in your project.

---

## Sixty seconds

Create (or edit) `middleware.ts` at your project root (or `src/middleware.ts`):

```ts
import { crawlertoll } from "@crawlertoll/next";

export default crawlertoll({
  offer: {
    rail: "x402",
    priceMicros: 5000,
    currency: "USD",
  },
  contextLicenseUrl: "https://example.com/.well-known/context-license.json",
  termsUrl: "https://example.com/ai-terms",
});

// Run on every route except Next.js internals.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

Deploy with `vercel deploy` (or your platform of choice). Any AI crawler hitting your endpoints gets a 402 with Cloudflare-shape `Crawler-Price` headers and a JSON payment offer. Browsers pass through.

---

## With an RSL 1.0 policy

The middleware accepts your robots.txt body directly. Policy is parsed once on first request, then cached.

```ts
// middleware.ts
import { crawlertoll } from "@crawlertoll/next";

const ROBOTS_TXT = `
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /
Allow: /public
License: https://example.com/ai-license
Permits: ai-search, rag
Prohibits: ai-training
Compensation: per-crawl 5000 micros USD
Standard: RSL/1.0

User-agent: *
Disallow:
`;

export default crawlertoll({
  policy: ROBOTS_TXT,
  offer: {
    rail: "x402",
    priceMicros: 5000,
    currency: "USD",
    paymentUrl: "https://pay.example.com/abc",
  },
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

Behaviour:

- GPTBot or ClaudeBot hits `/articles` → **402** with the payment offer (Disallow + Compensation = charge)
- GPTBot hits `/public/anything` → **200** (Allow override)
- Random browser → **200** (`*` catch-all is `Disallow:`)

Don't forget to also **serve** `/robots.txt` from your Next app so crawlers can fetch it. Either:

```ts
// app/robots.txt/route.ts  (App Router)
export const GET = () => new Response(ROBOTS_TXT, {
  headers: { "content-type": "text/plain; charset=utf-8" },
});
```

Or use Next's [`robots.ts`](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots) metadata file for the simple case and put the full RSL directives in `public/robots.txt`.

---

## Reading the decision in route handlers

The middleware forwards the decision downstream via custom request headers (the idiomatic Next pattern). Read them in any Server Component, API route, or Route Handler with `headers()`:

```ts
// app/articles/[id]/page.tsx  (Server Component)
import { headers } from "next/headers";

export default async function Article({ params }: { params: Promise<{ id: string }> }) {
  const h = await headers();
  const action = h.get("x-crawlertoll-action");          // "allow" | "402" | "block"
  const operator = h.get("x-crawlertoll-operator");      // "OpenAI" | "Anthropic" | ...
  const botName = h.get("x-crawlertoll-bot-name");       // "GPTBot" | "ClaudeBot" | ...
  const verified = h.get("x-crawlertoll-verified");      // "true" | "false" | ""

  if (action === "allow" && operator) {
    console.log("verified bot reading article", operator, botName);
  }

  // ... render the article
}
```

```ts
// app/api/articles/route.ts  (Route Handler)
import { headers } from "next/headers";

export async function GET() {
  const h = await headers();
  const action = h.get("x-crawlertoll-action");
  return Response.json({
    articles: [/* ... */],
    decision: action,
  });
}
```

---

## All options

```ts
crawlertoll({
  /** Payment offer surfaced when the decision is 402. */
  offer?: PaymentOffer,

  /** RSL 1.0 policy. Pass parsed `RslPolicy` or raw robots.txt text. */
  policy?: RslPolicy | string,

  /** Convenience: terms-of-use URL injected as Link rel="terms-of-service". */
  termsUrl?: string,

  /** Convenience: /.well-known/context-license.json URL injected as Link rel="describedby". */
  contextLicenseUrl?: string,

  /** Run Web Bot Auth verification when signature headers are present. Default true. */
  verifyAuth?: boolean,

  /** Trust verified bots even when policy would charge them. Default false. */
  trustVerifiedBots?: boolean,

  /** Forward decision via x-crawlertoll-* request headers. Default true. */
  forwardDecisionHeaders?: boolean,

  /** Called after every decision. Telemetry hook. */
  onDecision?: (decision, request) => void | Promise<void>,

  /** Short-circuit the decision pipeline. */
  decisionOverride?: (request) => Decision | null | Promise<Decision | null>,

  /** Pass-through options to build402(). */
  buildOptions?: Omit<Build402Options, "offer">,
})
```

---

## Custom matcher

Next middleware runs on every route by default. Use the `config.matcher` export to scope it. Common patterns:

```ts
// Only /api/* — protect your API, skip marketing pages
export const config = {
  matcher: ["/api/:path*"],
};

// Everything except Next internals + your /public/* free preview
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|public/).*)",
  ],
};

// Only specific routes
export const config = {
  matcher: ["/articles/:path*", "/api/articles/:path*"],
};
```

The middleware itself doesn't filter — it runs whatever Next sends. Use `matcher` for performance and to keep marketing-page crawls out of the decision pipeline.

---

## Telemetry hook

`onDecision` fires after every decision. Best-effort: errors are caught and swallowed (telemetry must not break the request). Run async work with `request.waitUntil()` when available:

```ts
export default crawlertoll({
  offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
  onDecision: async (decision, request) => {
    // On Vercel Edge / Cloudflare Workers: non-blocking telemetry.
    await fetch("https://your-metrics.example.com/ingest", {
      method: "POST",
      body: JSON.stringify({
        ts: Date.now(),
        path: request.nextUrl.pathname,
        action: decision.action,
        operator: decision.bot.entry?.operator ?? null,
        verified: decision.authVerified?.valid ?? null,
      }),
    });
  },
});
```

---

## Forwarded headers — full reference

| Header | Value |
|---|---|
| `x-crawlertoll-action` | `allow` / `402` / `block` |
| `x-crawlertoll-operator` | `OpenAI` / `Anthropic` / `Google` / `Apple` / `Perplexity` / `Meta` / `ByteDance` / `Common Crawl` / `Cohere` / `Mistral` / `You.com` / `Diffbot` / `Bright Data` / etc, or `""` for unknown |
| `x-crawlertoll-bot-name` | `GPTBot` / `ChatGPT-User` / `ClaudeBot` / `Claude-User` / `Google-Extended` / `PerplexityBot` / etc, or `""` for unknown |
| `x-crawlertoll-bot-category` | `training` / `inference` / `search` / `agent` / `scraper` / `""` |
| `x-crawlertoll-verified` | `true` (Web Bot Auth signature valid) / `false` (present but invalid) / `""` (no signature header) |

These are stamped on **both** the forwarded request headers (via `NextResponse.next({ request: { headers } })`) and the response headers. Reverse proxies and edge-logging that inspect the response see the same context downstream Server Components do.

---

## Conformance

9 vitest tests with synthetic `NextRequest`:

- Browser passes through (allow)
- Known bot → 402 with crawler-price + structured body
- Bot allow-list (no offer) → allow
- x-crawlertoll-* headers stamped on allow responses
- RSL policy: blocked → 403, charge model → 402, Allow override → 200
- onDecision telemetry hook fires for every request
- decisionOverride short-circuits
- forwardDecisionHeaders: false suppresses x-crawlertoll-*

Run them:

```bash
git clone https://github.com/charthouse-ltd/crawlertoll-next-js
cd crawlertoll-next-js
npm install
npm test
```

---

## Compatible frameworks

This package is the Next.js adapter. Other framework adapters use the same `@crawlertoll/core` engine — semantics are identical, only the request/response shim differs.

- `@crawlertoll/express` (Node, Express 4 + 5)
- `@crawlertoll/fastify` (Node, Fastify 4 + 5)
- `@crawlertoll/hono` (CF Workers, Bun, Deno, Vercel Edge, Node)
- `@crawlertoll/next` (this package — Next.js 14 + 15)

If your framework isn't listed, use `@crawlertoll/core`'s `decide()` directly — it's framework-agnostic.

---

## License

[Apache-2.0](./LICENSE). All specs implemented are open standards under their own licenses.

## Trademark

CrawlerToll™ is a trademark of Charthouse Ltd.

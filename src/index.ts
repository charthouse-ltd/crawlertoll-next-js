/**
 * @crawlertoll/next — Next.js middleware for the AI-crawler economy.
 *
 *   // middleware.ts (project root, or src/middleware.ts)
 *   import { crawlertoll } from "@crawlertoll/next";
 *
 *   export default crawlertoll({
 *     offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
 *     contextLicenseUrl: "https://example.com/.well-known/context-license.json",
 *   });
 *
 *   export const config = {
 *     matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
 *   };
 *
 * Next.js middleware runs on the Vercel Edge runtime (V8 isolates, same
 * substrate as Cloudflare Workers). The function signature is:
 *
 *     (request: NextRequest) => Promise<NextResponse | Response | undefined>
 *
 * Return `NextResponse.next()` (or `undefined`) to pass through. Return
 * a `NextResponse` with status to short-circuit.
 *
 * The decision is forwarded to downstream route handlers via custom
 * request headers — the idiomatic Next pattern for middleware-to-page
 * data passing:
 *
 *     x-crawlertoll-action      — "allow" | "402" | "block"
 *     x-crawlertoll-operator    — "OpenAI" | "Anthropic" | ... | "" (unknown)
 *     x-crawlertoll-bot-name    — "GPTBot" | "ClaudeBot" | ... | "" (unknown)
 *     x-crawlertoll-verified    — "true" | "false" | ""
 *     x-crawlertoll-bot-category — "training" | "inference" | "search" | "agent" | "scraper" | ""
 *
 * Read them in a Server Component / API route with `headers()`:
 *
 *     import { headers } from "next/headers";
 *     const h = await headers();
 *     const action = h.get("x-crawlertoll-action");
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  decide,
  parseRobotsTxt,
  type Build402Options,
  type Decision,
  type DecideInput,
  type PaymentOffer,
  type RslPolicy,
} from "@crawlertoll/core";

export interface CrawlerTollOptions {
  /** Payment offer to surface when the decision is 402. */
  offer?: PaymentOffer;
  /** Options forwarded to `build402()`. */
  buildOptions?: Omit<Build402Options, "offer">;
  /** Convenience: terms-of-use URL injected as Link rel="terms-of-service". */
  termsUrl?: string;
  /** Convenience: /.well-known/context-license.json URL injected as Link rel="describedby". */
  contextLicenseUrl?: string;
  /**
   * RSL 1.0 policy. Pass either an already-parsed `RslPolicy` or the raw
   * robots.txt body — the middleware parses it once on first request.
   */
  policy?: RslPolicy | string;
  /** Run Web Bot Auth verification when signature headers are present. Default true. */
  verifyAuth?: boolean;
  /** Trust verified bots even when policy would charge them. Default false. */
  trustVerifiedBots?: boolean;
  /**
   * Called for every request after a decision. Telemetry hook. Errors
   * are caught and swallowed (telemetry must not break the request).
   */
  onDecision?: (decision: Decision, request: NextRequest) => void | Promise<void>;
  /**
   * Hook to short-circuit the decision before any of the standard logic.
   * Return `null` to fall through; return a `Decision` to override.
   */
  decisionOverride?: (request: NextRequest) => Decision | null | Promise<Decision | null>;
  /**
   * Forward the decision to downstream route handlers via request
   * headers. Default true. Set false on the rare apps that have strict
   * header-allowlisting on their own routes.
   */
  forwardDecisionHeaders?: boolean;
}

const DEFAULT_OPTIONS: Required<
  Pick<
    CrawlerTollOptions,
    "verifyAuth" | "trustVerifiedBots" | "forwardDecisionHeaders"
  >
> = {
  verifyAuth: true,
  trustVerifiedBots: false,
  forwardDecisionHeaders: true,
};

/**
 * Build the Next.js middleware. Returns a function suitable as the
 * default export of `middleware.ts`.
 */
export function crawlertoll(options: CrawlerTollOptions = {}) {
  // Lazily resolve the policy on first request, then memoise.
  let resolvedPolicy: RslPolicy | undefined;
  let policyResolved = false;
  const resolvePolicy = (): RslPolicy | undefined => {
    if (policyResolved) return resolvedPolicy;
    policyResolved = true;
    if (typeof options.policy === "string") {
      const { policy } = parseRobotsTxt(options.policy);
      resolvedPolicy = policy;
    } else if (options.policy) {
      resolvedPolicy = options.policy;
    }
    return resolvedPolicy;
  };

  const cfg = { ...DEFAULT_OPTIONS, ...options };

  return async function middleware(
    request: NextRequest,
  ): Promise<NextResponse> {
    const decision = await runDecision(request, cfg, resolvePolicy);

    if (options.onDecision) {
      Promise.resolve()
        .then(() => options.onDecision!(decision, request))
        .catch(() => {
          /* swallow */
        });
    }

    if (decision.action === "allow") {
      if (cfg.forwardDecisionHeaders) {
        // Forward on the *request* headers so downstream Server
        // Components / API routes can read via `headers()`.
        const forwardedRequestHeaders = new Headers(request.headers);
        setDecisionHeaders(forwardedRequestHeaders, decision);
        const response = NextResponse.next({
          request: { headers: forwardedRequestHeaders },
        });
        // Stamp on the *response* headers too — useful for reverse
        // proxies, edge logging, and tests that don't run through a
        // real Next.js server.
        setDecisionHeaders(response.headers, decision);
        return response;
      }
      return NextResponse.next();
    }

    if (decision.action === "402" && decision.built) {
      const responseHeaders = new Headers(decision.built.headers);
      if (cfg.forwardDecisionHeaders) {
        setDecisionHeaders(responseHeaders, decision);
      }
      return new NextResponse(decision.built.body, {
        status: decision.built.status,
        headers: responseHeaders,
      });
    }

    if (decision.action === "block") {
      const body = JSON.stringify({
        error: "forbidden",
        message: "Crawler access denied by site policy.",
        reasons: decision.reasons,
      });
      const responseHeaders = new Headers({
        "content-type": "application/json; charset=utf-8",
      });
      if (cfg.forwardDecisionHeaders) {
        setDecisionHeaders(responseHeaders, decision);
      }
      return new NextResponse(body, { status: 403, headers: responseHeaders });
    }

    // Unknown action — fall through.
    return NextResponse.next();
  };
}

async function runDecision(
  request: NextRequest,
  cfg: CrawlerTollOptions & typeof DEFAULT_OPTIONS,
  resolvePolicy: () => RslPolicy | undefined,
): Promise<Decision> {
  if (cfg.decisionOverride) {
    const override = await cfg.decisionOverride(request);
    if (override) return override;
  }

  const headers = normaliseHeaders(request.headers);
  const policy = resolvePolicy();

  const buildOptions: Omit<Build402Options, "offer"> = {
    ...(cfg.contextLicenseUrl ? { contextLicenseUrl: cfg.contextLicenseUrl } : {}),
    ...(cfg.termsUrl ? { termsUrl: cfg.termsUrl } : {}),
    ...(cfg.buildOptions ?? {}),
  };

  const url = request.nextUrl;
  const authority = headers["host"] ?? url.host;
  const targetUri = url.pathname + (url.search ?? "");

  const input: DecideInput = {
    request: {
      method: request.method,
      authority,
      targetUri,
      path: url.pathname,
      headers,
    },
    verifyAuth: cfg.verifyAuth,
    trustVerifiedBots: cfg.trustVerifiedBots,
    ...(policy ? { policy } : {}),
    ...(cfg.offer ? { offer: cfg.offer } : {}),
    ...(Object.keys(buildOptions).length ? { buildOptions } : {}),
  };

  return decide(input);
}

function normaliseHeaders(raw: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  raw.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Stamp the decision onto a Headers bag. Both directions:
 *   - On `request.headers` of a passed-through response, so downstream
 *     Server Components / API routes can read via `headers()`.
 *   - On the response headers of a 402 / 403, so reverse proxies and
 *     edge logging see the decision context too.
 */
function setDecisionHeaders(headers: Headers, decision: Decision): void {
  headers.set("x-crawlertoll-action", decision.action);
  headers.set("x-crawlertoll-operator", decision.bot.entry?.operator ?? "");
  headers.set("x-crawlertoll-bot-name", decision.bot.entry?.name ?? "");
  headers.set("x-crawlertoll-bot-category", decision.bot.entry?.category ?? "");
  headers.set(
    "x-crawlertoll-verified",
    decision.authVerified?.valid !== undefined
      ? String(decision.authVerified.valid)
      : "",
  );
}

// ─── Type re-exports for consumer ergonomics ───────────────────────

export type {
  Build402Options,
  Built402Response,
  PaymentOffer,
  SettlementRail,
  Decision,
  DecisionAction,
  RslPolicy,
} from "@crawlertoll/core";

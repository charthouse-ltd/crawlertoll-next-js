# Changelog

All notable changes to `@crawlertoll/next` are documented here.

The package follows [Semantic Versioning](https://semver.org/) and tracks the `@crawlertoll/core` major version.

## [0.1.1] — 2026-05-21

### Changed

- Repository URL updated after the GitHub org rename `nhrzxxw9dn-web` → `charthouse-ltd` (npm scope unchanged: `@crawlertoll/*`). Metadata-only release; no code changes.

## [0.1.0] — 2026-05-19

Initial release. Ships alongside `@crawlertoll/core` v0.1.0, `@crawlertoll/express` v0.1.0, `@crawlertoll/hono` v0.1.0, and `@crawlertoll/fastify` v0.1.0.

### Added

- `crawlertoll(options)` factory returns a Next.js middleware function — drop into `middleware.ts` as the default export.
- Decision forwarded downstream via `x-crawlertoll-action`, `x-crawlertoll-operator`, `x-crawlertoll-bot-name`, `x-crawlertoll-bot-category`, `x-crawlertoll-verified` headers on both the forwarded request and the response. Readable in Server Components and API routes via `headers()`.
- Supports inline RSL 1.0 policy via `options.policy: RslPolicy | string` (raw robots.txt is parsed once and cached).
- `onDecision` telemetry hook (best-effort; errors swallowed).
- `decisionOverride` hook for whitelisted-internal-service patterns.
- `verifyAuth` (default true), `trustVerifiedBots` (default false), and `forwardDecisionHeaders` (default true) toggles.
- Next.js 14.x and 15.x compatible (peer dependency).
- Edge-runtime compatible: uses only `NextRequest` / `NextResponse` and Web Crypto, no Node-only APIs.

### Conformance

- 9/9 vitest tests via synthetic `NextRequest` (no Next.js server required).
- Re-uses `@crawlertoll/core`'s 47-test conformance suite indirectly through the decision engine.
- Decision identical (byte-for-byte) to `@crawlertoll/express`, `@crawlertoll/fastify`, and `@crawlertoll/hono` for the same input — same core engine.

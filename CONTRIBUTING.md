# Contributing

Thanks for your interest in contributing to `@genai-otel/core`. This document
covers the basics: dev setup, running tests, and conventions.

## Dev setup

```bash
pnpm install
pnpm run build
```

Node 22+ is required (`engines.node` in `package.json`); CI covers Node 22 and
24. The project uses pnpm (version pinned via `packageManager` in
`package.json` — Corepack will pick it up automatically).

## Running tests

```bash
pnpm run test         # lint + typecheck + full suite once (the pre-PR gate)
pnpm run test:unit    # vitest only, skipping lint and typecheck
pnpm run test:watch   # rerun on changes
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # biome check
pnpm run lint:fix     # biome check --write
```

`pnpm run test` runs the checks in cheapest-first order and stops at the first
failure, so a lint or type error surfaces without waiting on the suite. Use
`pnpm run test:unit` or `pnpm run test:watch` for the tight inner loop.

## Conventions

- TypeScript strict mode. No `any` outside provider-typed boundaries.
- Keep core (`src/`) free of `@opentelemetry/sdk-*` imports — only
  `@opentelemetry/api` types are allowed in core. SDK code lives in
  `src/bootstrap/`.
- Library-specific attributes go under the `genai.*` namespace; only OTel
  spec attributes use `gen_ai.*`.
- Tests are in `test/`. Vitest. Use the `_harness` for end-to-end span /
  metric assertions.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## Contributor agreement

Before we can merge your pull request, you need to agree to the Snowflake
[contributor license agreement](https://github.com/Snowflake-Labs/CLA).

## Reporting issues

For security vulnerabilities, do **not** open a public issue — see
[`SECURITY.md`](SECURITY.md) for private reporting.

Open a GitHub issue with:

- A minimal repro
- The version of `@genai-otel/core` you're on
- The OTel exporter / backend you're using

## Submitting changes

- Open a PR against `main`.
- Run `pnpm run test` locally first — it covers lint, typecheck, and the suite.
- Update `CHANGELOG.md` under `[Unreleased]`.

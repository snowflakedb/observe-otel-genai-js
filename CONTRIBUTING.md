# Contributing

Thanks for your interest in contributing to `@genai-otel/core`. This document
covers the basics: dev setup, running tests, and conventions.

## Dev setup

```bash
pnpm install
pnpm run build
```

Node 20+ is required. The project uses pnpm (version pinned via
`packageManager` in `package.json` — Corepack will pick it up automatically).

## Running tests

```bash
pnpm run test         # full suite once
pnpm run test:watch   # rerun on changes
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # biome check
pnpm run lint:fix     # biome check --write
```

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

## Reporting issues

Open a GitHub issue with:

- A minimal repro
- The version of `@genai-otel/core` you're on
- The OTel exporter / backend you're using

## Submitting changes

- Open a PR against `main`.
- Run `pnpm run lint && pnpm run typecheck && pnpm run test` locally first.
- Update `CHANGELOG.md` under `[Unreleased]`.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A personal, local-use tool that automatically uploads YouTube videos from a local archive on a schedule. The repo is currently scaffolding only: `src/index.ts` is empty and `tests/` has no files yet. There is no architecture yet. Update this file as one emerges.

## Commands

- `npm run dev` runs `src/index.ts` with `tsx` in watch mode.
- `npm run build` compiles `src/` to `dist/` with `tsc`.
- `npm start` runs `node dist/index.js`.
- `npm run typecheck` runs `tsc --noEmit`.
- `npm run lint` runs `biome check .` (lint and formatting). `npm run lint:fix` applies fixes.
- `npm test` runs Vitest once. `npm run test:watch` runs it in watch mode.
- To run one test file, use `npm test -- tests/foo.test.ts`. To filter by test name, use `npm test -- -t "name"`.

## Toolchain notes

- ESM (`"type": "module"`) with `module: nodenext`. Relative imports need explicit `.js` extensions, for example `import { x } from "./foo.js"`.
- `verbatimModuleSyntax` is on, so type-only imports must use `import type`.
- Strict TS, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Indexed access returns `T | undefined`, and optional properties can't be assigned `undefined` explicitly unless their type includes it.
- `tsconfig.json` includes only `src/` (`rootDir: ./src`, `outDir: ./dist`). `tsc` therefore doesn't typecheck `tests/`, but Vitest still transpiles and runs those files. Node types are loaded via `"types": ["node"]`.
- Biome formatting uses tabs and double quotes, and organize-imports is enabled.
- There is no Vitest config file, so Vitest's defaults apply.
- Secrets such as YouTube OAuth credentials belong in `.env`, which is gitignored. `.env.example` is the only env file allowed to be committed.

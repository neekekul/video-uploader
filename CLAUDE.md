# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A personal tool that watches a drop folder for archives (`.zip`, `.tar.gz`/`.tgz`), each holding one video plus optional description, metadata, thumbnail and captions, and uploads them on a schedule. YouTube is the first target, and the design allows several platforms per archive.

Status: the core pipeline is done and runs with the `dry-run` platform. Still planned: the YouTube platform and `auth youtube` command (stage 2), then Docker (stage 3).

## Commands

- `npm run dev` runs the scheduler (`start`) with `tsx` in watch mode.
- `npm run run-once` processes the inbox once and exits. This is the quickest way to try a change by hand.
- `npm run build` compiles `src/` to `dist/`. `npm start` runs the built scheduler.
- `npm run typecheck` typechecks `src/` and `tests/` through `tsconfig.check.json`.
- `npm run lint` runs Biome (lint and formatting). `npm run lint:fix` applies fixes.
- `npm test` runs Vitest once. For one file, use `npm test -- tests/run.test.ts`. To filter by test name, use `npm test -- -t "retries"`.

Configuration comes from environment variables, optionally loaded from `.env`. See `.env.example`. `PLATFORMS` defaults to `dry-run`.

## Architecture

Drop folder layout under `DROP_DIR`: `inbox/ → processing/ → done/ | failed/`, plus `work/` for temporary extraction.

**Run** (`src/job/run.ts`, triggered by `src/scheduler.ts` via croner, which never overlaps runs):

1. Recover crash leftovers. Archives still in `processing/` go back to `inbox/` (counted as an interrupted attempt), and `work/` is emptied. This assumes only one instance uses the drop folder.
2. `scanInbox` samples each archive's size and mtime twice, `STABILITY_WAIT_SECONDS` apart, and skips files still being copied.
3. Claim each ready archive by renaming it into `processing/`. A failed rename means the file is locked and is skipped.
4. `processArchive` for each claimed archive, one at a time.

**processArchive** (`src/job/process-archive.ts`): extract, inspect (`src/archive/inspect.ts`), then load and validate metadata (`src/metadata/`). Next it builds the description (header, `description.txt`, footer from `CONFIG_DIR`) and resolves target platforms (`metadata.platforms`, falling back to the `PLATFORMS` env var). It runs every platform's `validate()` before any upload, uploads to each platform, then moves the archive. `work/<uuid>` is always deleted.

**The result log is the job state.** `<archive>.log.json` sits next to the archive and moves with it.

- `uploaded` records the platforms that succeeded, so a retry skips them. It is written right after each successful upload so a crash can't cause a duplicate upload.
- `attemptsInRound` counts attempts against `MAX_ATTEMPTS` (default 2: one try plus one retry). It resets when a finished (`done`/`failed`) archive is dropped back into the inbox.

**Failure routing:**

- `ValidationError` (`src/errors.ts`) is used for problems retrying can't fix, such as a bad archive, invalid metadata, an unknown platform or a failed platform `validate()`. These go straight to `failed/`.
- Any other error sends the archive back to `inbox/` for the next run, until attempts run out.

**Platforms** implement `Platform` (`src/platforms/types.ts`): `validate(job)` and `upload(job, logger)`. Register them in `src/platforms/registry.ts`. Platform-specific metadata goes in its own top-level section of the metadata schema. For example, `youtube:` is defined in `src/platforms/youtube/options.ts` and wired into `src/metadata/schema.ts`. All metadata objects are `strictObject`, so unknown keys (typos) fail validation.

**Extraction safety** (`src/archive/extract.ts`): every entry path goes through `safeJoin`, and tar links and device entries are dropped. The zip file handle is always closed, because an open handle blocks moving the archive on Windows. Errors thrown inside tar's `filter` callback escape its promise, so collect problems there and throw afterwards.

## Testing

Tests (`tests/`) build real zip and tar.gz archives in temp dirs (`tests/helpers.ts`: `makeZip`, `makeTarGz`, `makeContext`, `fakePlatform`) and run `runOnce` end to end. `fakePlatform(name, behave)` takes a per-call function, so it can fail on call 1 and succeed on call 2.

## Toolchain notes

- ESM with `module: nodenext`. Relative imports need explicit `.js` extensions.
- `verbatimModuleSyntax` is on, so type-only imports need `import type`.
- Strict TS, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Don't assign `undefined` to optional properties. Either add the key conditionally or type the property as `?: T | undefined`.
- `tsconfig.json` builds only `src/`. `tsconfig.check.json` adds `tests/` for typechecking.
- Biome uses tabs, double quotes and an 80-column line width.
- The Write and Edit tools turn `﻿` escapes into a literal invisible BOM character. Check the bytes (`od -c`) after editing code that contains one.
- `.env`, `/drop/` and the real `config/description-*.txt` files are gitignored. Commit the `.example` versions only.

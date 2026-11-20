# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A personal tool that watches a drop folder for archives (`.zip`, `.tar.gz`/`.tgz`), each holding one video plus optional description, metadata, thumbnail and captions, and uploads them on a schedule. YouTube is the first target, and the design allows several platforms per archive.

Status: the core pipeline and the YouTube platform are done. Still planned: Docker (stage 3) and docs (stage 4). Google Cloud setup steps are in README.md.

## Commands

- `npm run dev` runs the scheduler (`start`) with `tsx` in watch mode.
- `npm run run-once` processes the inbox once and exits. This is the quickest way to try a change by hand. Set `PLATFORMS=dry-run` to skip real uploads.
- `npm run auth:youtube` does the one-time browser sign-in and writes the refresh token.
- `npm run build` compiles `src/` to `dist/`. `npm start` runs the built scheduler.
- `npm run typecheck` typechecks `src/` and `tests/` through `tsconfig.check.json`.
- `npm run lint` runs Biome (lint and formatting). `npm run lint:fix` applies fixes.
- `npm test` runs Vitest once. For one file, use `npm test -- tests/run.test.ts`. To filter by test name, use `npm test -- -t "retries"`.

Configuration comes from environment variables, optionally loaded from `.env`. See `.env.example`. `PLATFORMS` defaults to `youtube`. YouTube credentials live in `credentials/`, which is gitignored.

## Architecture

Drop folder layout under `DROP_DIR`: `inbox/ → processing/ → done/ | failed/`, plus `work/` for temporary extraction.

**Run** (`src/job/run.ts`, triggered by `src/scheduler.ts` via croner, which never overlaps runs):

1. Take the drop-folder lock (`src/job/lock.ts`, `DROP_DIR/.lock`), or skip the run if another instance holds it. Liveness is a heartbeat on the lock's mtime, not a PID check, because PIDs mean nothing across a container and the host. A lock untouched for 2 minutes is treated as stale and taken over. Signal handlers call `releaseHeldLocksSync()` so a quick restart doesn't skip its first run.
2. Recover crash leftovers. Because the lock is held, anything in `processing/` was interrupted: it goes back to `inbox/` (counted as an attempt), and `work/` is emptied.
3. `scanInbox` samples each archive's size and mtime twice, `STABILITY_WAIT_SECONDS` apart, and skips files still being copied.
4. If any archives are ready, run `preflight()` for each default platform (`src/job/readiness.ts`, at most once per platform per run). If one fails, the run stops and the inbox is left untouched: nothing is extracted, no log is written, and no attempt is used.
5. Claim each ready archive by renaming it into `processing/`. A failed rename means the file is locked and is skipped.
6. `processArchive` for each claimed archive, one at a time.

**processArchive** (`src/job/process-archive.ts`): extract, inspect (`src/archive/inspect.ts`), then load and validate metadata (`src/metadata/`). Next it builds the description (header, `description.txt`, footer from `CONFIG_DIR`) and resolves target platforms (`metadata.platforms`, falling back to the `PLATFORMS` env var). It runs every platform's `validate()` before any upload, uploads to each platform, then moves the archive. `work/<uuid>` is always deleted.

**The result log is the job state.** `<archive>.log.json` sits next to the archive and moves with it.

- `uploaded` records the platforms that succeeded, so a retry skips them. It is written right after each successful upload so a crash can't cause a duplicate upload.
- `attemptsInRound` counts attempts against `MAX_ATTEMPTS` (default 2: one try plus one retry). It resets when a finished (`done`/`failed`) archive is dropped back into the inbox.

**Failure routing:**

- `ValidationError` (`src/errors.ts`) is used for problems retrying can't fix, such as a bad archive, invalid metadata, an unknown platform or a failed platform `validate()`. These go straight to `failed/`.
- `PlatformNotReadyError` comes from a failed `preflight()` for a platform the archive's metadata selected. The archive goes back to `inbox/` as `waiting`, and `attemptsInRound` is decremented, so setup problems never push archives into `failed/`.
- Any other error sends the archive back to `inbox/` for the next run, until attempts run out.

**Platforms** implement `Platform` (`src/platforms/types.ts`): `validate(job)`, `upload(job, logger)`, and an optional `preflight(logger)` readiness check. Register them in `src/platforms/registry.ts`. Platform-specific metadata goes in its own top-level section of the metadata schema. For example, `youtube:` is defined in `src/platforms/youtube/options.ts` and wired into `src/metadata/schema.ts`. All metadata objects are `strictObject`, so unknown keys (typos) fail validation.

**YouTube** (`src/platforms/youtube/`):

- `platform.ts` runs `videos.insert`, then sets the thumbnail, uploads captions and adds the video to playlists. **Once the insert succeeds, nothing may throw.** Failures in the later steps become `UploadResult.warnings`, because a thrown error would make the retry upload the video a second time.
- `api.ts` is a narrow `YoutubeApi` interface over `@googleapis/youtube`, so tests pass a fake instead.
- `resource.ts` turns a job into the insert request (privacy defaults to `private`, category to `22`) and checks YouTube's limits up front in `validateForYoutube`.
- `errors.ts` turns gaxios errors (quota, `invalid_grant`, and so on) into one readable line.
- `credentials.ts` and `auth-flow.ts` handle OAuth: a "Desktop app" client, a loopback redirect with PKCE and a state check, and the scopes `youtube.upload` + `youtube.force-ssl`. Credentials are only read when a run has work for YouTube, so `dry-run` works without them. The YouTube `preflight` exchanges the refresh token for an access token. That catches a missing, revoked or expired sign-in and costs no quota.

**Extraction safety** (`src/archive/extract.ts`): every entry path goes through `safeJoin`, and tar links and device entries are dropped. The zip file handle is always closed, because an open handle blocks moving the archive on Windows. Errors thrown inside tar's `filter` callback escape its promise, so collect problems there and throw afterwards.

## Testing

Tests (`tests/`) build real zip and tar.gz archives in temp dirs (`tests/helpers.ts`: `makeZip`, `makeTarGz`, `makeContext`, `fakePlatform`) and run `runOnce` end to end. `fakePlatform(name, behave)` takes a per-call function, so it can fail on call 1 and succeed on call 2.

## Toolchain notes

- ESM with `module: nodenext`. Relative imports need explicit `.js` extensions.
- `verbatimModuleSyntax` is on, so type-only imports need `import type`.
- Strict TS, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Don't assign `undefined` to optional properties. Either add the key conditionally or type the property as `?: T | undefined`.
- `tsconfig.json` builds only `src/`. `tsconfig.check.json` adds `tests/` for typechecking.
- Biome uses tabs, double quotes and an 80-column line width.
- The Write and Edit tools turn a BOM escape sequence (backslash, `u`, `FEFF`) into the literal invisible character. After editing code that contains one, check the bytes with `od -c`, and fix it with a script that builds the escape via `String.fromCharCode(92)`.
- `.env`, `/drop/`, `/credentials/` and the real `config/description-*.txt` files are gitignored. Commit the `.example` versions only.

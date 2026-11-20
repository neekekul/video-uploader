import { access, readdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	acquireDropLock,
	LOCK_FILE,
	releaseHeldLocksSync,
} from "../src/job/lock.js";
import { runOnce } from "../src/job/run.js";
import { ensureDropDirs } from "../src/paths.js";
import {
	fakePlatform,
	makeContext,
	makeZip,
	tempDir,
	VIDEO,
} from "./helpers.js";

describe("acquireDropLock", () => {
	it("is exclusive until released", async () => {
		const dir = await tempDir();
		const first = await acquireDropLock(dir);
		expect(first.acquired).toBe(true);

		const second = await acquireDropLock(dir);
		expect(second).toMatchObject({
			acquired: false,
			holder: { pid: process.pid },
		});

		if (first.acquired) await first.lock.release();
		const third = await acquireDropLock(dir);
		expect(third.acquired).toBe(true);
		if (third.acquired) await third.lock.release();
	});

	it("takes over a lock that has not been refreshed within staleMs", async () => {
		const dir = await tempDir();
		const lockPath = path.join(dir, LOCK_FILE);
		await writeFile(lockPath, "{}");
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(lockPath, old, old);

		const result = await acquireDropLock(dir, { staleMs: 60_000 });

		expect(result).toMatchObject({ acquired: true, tookOverStale: true });
		if (result.acquired) await result.lock.release();
	});

	it("keeps a held lock fresh with a heartbeat", async () => {
		const dir = await tempDir();
		const result = await acquireDropLock(dir, { heartbeatMs: 20 });
		const lockPath = path.join(dir, LOCK_FILE);
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(lockPath, old, old);

		await sleep(100);

		expect(Date.now() - (await stat(lockPath)).mtimeMs).toBeLessThan(5_000);
		if (result.acquired) await result.lock.release();
	});

	it("releaseHeldLocksSync removes locks held by this process", async () => {
		const dir = await tempDir();
		await acquireDropLock(dir);
		releaseHeldLocksSync();
		await expect(access(path.join(dir, LOCK_FILE))).rejects.toThrow();
	});
});

describe("runOnce with the lock", () => {
	it("skips the run while another instance holds the lock", async () => {
		const platform = fakePlatform("fake");
		const ctx = await makeContext([platform]);
		await ensureDropDirs(ctx.paths);
		await makeZip(path.join(ctx.paths.inbox, "clip.zip"), { "v.mp4": VIDEO });
		const other = await acquireDropLock(ctx.config.dropDir);

		const summary = await runOnce(ctx);

		expect(summary).toEqual({ ran: false, results: [], skipped: [] });
		expect(platform.calls).toHaveLength(0);
		expect(await readdir(ctx.paths.inbox)).toEqual(["clip.zip"]);
		if (other.acquired) await other.lock.release();
	});

	it("releases the lock after a run, even when the run throws", async () => {
		const ctx = await makeContext([fakePlatform("fake")]);
		await runOnce(ctx);
		await expect(
			access(path.join(ctx.config.dropDir, LOCK_FILE)),
		).rejects.toThrow();

		// Fail inside the locked section ("No archives ready" is logged at info).
		const boom = () => {
			throw new Error("boom");
		};
		await expect(
			runOnce({ ...ctx, logger: { ...ctx.logger, info: boom } }),
		).rejects.toThrow("boom");
		await expect(
			access(path.join(ctx.config.dropDir, LOCK_FILE)),
		).rejects.toThrow();
	});
});

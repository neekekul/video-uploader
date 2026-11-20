import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JobContext } from "../src/job/process-archive.js";
import type { ResultLog } from "../src/job/result-log.js";
import { runOnce } from "../src/job/run.js";
import { ensureDropDirs } from "../src/paths.js";
import { createRealYoutubePlatform } from "../src/platforms/youtube/platform.js";
import { fakePlatform, makeContext, makeZip, VIDEO } from "./helpers.js";

async function drop(
	ctx: JobContext,
	name: string,
	files: Record<string, string> = { "video.mp4": VIDEO },
) {
	await ensureDropDirs(ctx.paths);
	await makeZip(path.join(ctx.paths.inbox, name), files);
}

async function readResultLog(dir: string, archive: string): Promise<ResultLog> {
	return JSON.parse(
		await readFile(path.join(dir, `${archive}.log.json`), "utf8"),
	) as ResultLog;
}

/** A preflight that fails while `state.ready` is false, counting its calls. */
function switchablePreflight(state: { ready: boolean; calls: number }) {
	return async () => {
		state.calls++;
		if (!state.ready) throw new Error("sign-in expired");
	};
}

describe("platform readiness", () => {
	it("leaves the inbox untouched when a default platform is not ready", async () => {
		const state = { ready: false, calls: 0 };
		const platform = fakePlatform(
			"fake",
			undefined,
			undefined,
			switchablePreflight(state),
		);
		const ctx = await makeContext([platform]);
		await drop(ctx, "a.zip");
		await drop(ctx, "b.zip");

		const summary = await runOnce(ctx);

		expect(summary.blocked).toBe("fake is not ready: sign-in expired");
		expect(summary.results).toEqual([]);
		expect(summary.skipped.sort()).toEqual(["a.zip", "b.zip"]);
		expect(platform.calls).toHaveLength(0);
		expect(state.calls).toBe(1);
		// No log written, so no attempt was used.
		expect((await readdir(ctx.paths.inbox)).sort()).toEqual(["a.zip", "b.zip"]);

		state.ready = true;
		const next = await runOnce(ctx);
		expect(next.results.map((r) => r.outcome)).toEqual(["done", "done"]);
	});

	it("checks each platform once per run, not once per archive", async () => {
		const state = { ready: true, calls: 0 };
		const ctx = await makeContext([
			fakePlatform("fake", undefined, undefined, switchablePreflight(state)),
		]);
		await drop(ctx, "a.zip");
		await drop(ctx, "b.zip");
		await drop(ctx, "c.zip");

		await runOnce(ctx);

		expect(state.calls).toBe(1);
	});

	it("puts an archive back as waiting, without using an attempt, when its chosen platform is not ready", async () => {
		const state = { ready: false, calls: 0 };
		const other = fakePlatform(
			"other",
			undefined,
			undefined,
			switchablePreflight(state),
		);
		const ctx = await makeContext([fakePlatform("fake"), other], {
			defaultPlatforms: ["fake"],
		});
		await drop(ctx, "clip.zip", {
			"video.mp4": VIDEO,
			"metadata.yaml": "platforms: [other]",
		});

		expect((await runOnce(ctx)).results[0]?.outcome).toBe("waiting");
		const waiting = await readResultLog(ctx.paths.inbox, "clip.zip");
		expect(waiting.status).toBe("waiting");
		expect(waiting.attemptsInRound).toBe(0);
		expect(waiting.attempts[0]).toMatchObject({
			outcome: "deferred",
			error: "other is not ready: sign-in expired",
		});

		state.ready = true;
		expect((await runOnce(ctx)).results[0]?.outcome).toBe("done");
		const done = await readResultLog(ctx.paths.done, "clip.zip");
		expect(done.attemptsInRound).toBe(1);
		expect(done.attempts.map((a) => a.outcome)).toEqual([
			"deferred",
			"success",
		]);
		expect(other.calls).toHaveLength(1);
	});

	it("never fails an archive because of readiness, however many runs it waits", async () => {
		const state = { ready: false, calls: 0 };
		const ctx = await makeContext(
			[
				fakePlatform("fake"),
				fakePlatform("other", undefined, undefined, switchablePreflight(state)),
			],
			{ defaultPlatforms: ["fake"] },
		);
		await drop(ctx, "clip.zip", {
			"video.mp4": VIDEO,
			"metadata.yaml": "platforms: [other]",
		});

		for (let i = 0; i < 4; i++) {
			expect((await runOnce(ctx)).results[0]?.outcome).toBe("waiting");
		}
		expect(await readdir(ctx.paths.failed)).toEqual([]);
	});

	it("does not check a platform the archive was already uploaded to", async () => {
		const goodState = { ready: true, calls: 0 };
		const good = fakePlatform(
			"good",
			undefined,
			undefined,
			switchablePreflight(goodState),
		);
		const flaky = fakePlatform("flaky", (call) => {
			if (call === 1) throw new Error("network down");
			return { id: "ok" };
		});
		const ctx = await makeContext([good, flaky], {
			defaultPlatforms: ["flaky"],
		});
		await drop(ctx, "clip.zip", {
			"video.mp4": VIDEO,
			"metadata.yaml": "platforms: [good, flaky]",
		});

		expect((await runOnce(ctx)).results[0]?.outcome).toBe("retrying");
		goodState.ready = false;

		expect((await runOnce(ctx)).results[0]?.outcome).toBe("done");
		expect(good.calls).toHaveLength(1);
		expect(goodState.calls).toBe(1);
	});

	it("reports missing YouTube credentials without touching the inbox", async () => {
		const ctx = await makeContext([]);
		ctx.platforms.set("youtube", createRealYoutubePlatform(ctx.config.youtube));
		ctx.config.defaultPlatforms = ["youtube"];
		await drop(ctx, "clip.zip");

		const summary = await runOnce(ctx);

		expect(summary.blocked).toContain(
			"Could not read the YouTube OAuth client file",
		);
		expect(await readdir(ctx.paths.inbox)).toEqual(["clip.zip"]);
	});
});

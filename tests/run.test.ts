import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JobContext } from "../src/job/process-archive.js";
import { type ResultLog, writeLog } from "../src/job/result-log.js";
import { runOnce } from "../src/job/run.js";
import { scanInbox } from "../src/job/stability.js";
import { ensureDropDirs } from "../src/paths.js";
import {
	fakePlatform,
	makeContext,
	makeTarGz,
	makeZip,
	tempDir,
	VIDEO,
	writeFiles,
} from "./helpers.js";

async function drop(
	ctx: JobContext,
	name: string,
	files: Record<string, string>,
): Promise<string> {
	await ensureDropDirs(ctx.paths);
	const file = path.join(ctx.paths.inbox, name);
	return name.endsWith(".zip") ? makeZip(file, files) : makeTarGz(file, files);
}

async function readResultLog(dir: string, archive: string): Promise<ResultLog> {
	return JSON.parse(
		await readFile(path.join(dir, `${archive}.log.json`), "utf8"),
	) as ResultLog;
}

async function listing(ctx: JobContext) {
	const { inbox, processing, done, failed, work } = ctx.paths;
	return {
		inbox: await readdir(inbox),
		processing: await readdir(processing),
		done: await readdir(done),
		failed: await readdir(failed),
		work: await readdir(work),
	};
}

const failing =
	(message = "network down") =>
	() => {
		throw new Error(message);
	};

describe("runOnce", () => {
	it("uploads a valid archive and moves it to done/ with its log", async () => {
		const platform = fakePlatform("fake");
		const ctx = await makeContext([platform]);
		await writeFiles(ctx.config.configDir, {
			"description-header.txt": "HEADER",
			"description-footer.txt": "FOOTER",
		});
		await drop(ctx, "clip.zip", {
			"video.mp4": VIDEO,
			"description.txt": "Body",
			"metadata.yaml": "title: Custom Title\ntags: [a, b]",
			"thumbnail.jpg": "img",
			"en.srt": "1",
		});

		const summary = await runOnce(ctx);

		expect(summary.results).toEqual([{ archive: "clip.zip", outcome: "done" }]);
		expect(await listing(ctx)).toEqual({
			inbox: [],
			processing: [],
			done: ["clip.zip", "clip.zip.log.json"],
			failed: [],
			work: [],
		});
		const [job] = platform.calls;
		expect(job?.title).toBe("Custom Title");
		expect(job?.description).toBe("HEADER\n\nBody\n\nFOOTER");
		expect(job?.tags).toEqual(["a", "b"]);
		expect(job?.thumbnail).toMatch(/thumbnail\.jpg$/);
		expect(job?.captions.map((c) => c.language)).toEqual(["en"]);

		const log = await readResultLog(ctx.paths.done, "clip.zip");
		expect(log.status).toBe("done");
		expect(log.uploaded.fake?.id).toBe("fake-1");
		expect(log.attempts).toHaveLength(1);
		expect(log.attempts[0]?.outcome).toBe("success");
	});

	it("falls back to the archive name for the title and handles tar.gz", async () => {
		const platform = fakePlatform("fake");
		const ctx = await makeContext([platform]);
		await drop(ctx, "My Great Video.tar.gz", {
			"My Great Video/video.mp4": VIDEO,
		});

		await runOnce(ctx);

		expect(platform.calls[0]?.title).toBe("My Great Video");
		expect((await listing(ctx)).done).toContain("My Great Video.tar.gz");
	});

	it("processes every ready archive in one run", async () => {
		const platform = fakePlatform("fake");
		const ctx = await makeContext([platform]);
		await drop(ctx, "a.zip", { "v.mp4": VIDEO });
		await drop(ctx, "b.zip", { "v.mp4": VIDEO });
		await drop(ctx, "c.tar.gz", { "v.mp4": VIDEO });

		const summary = await runOnce(ctx);

		expect(summary.results.map((r) => r.outcome)).toEqual([
			"done",
			"done",
			"done",
		]);
		expect(platform.calls).toHaveLength(3);
	});

	it("retries a failed upload once on the next run", async () => {
		const platform = fakePlatform("fake", (call) => {
			if (call === 1) throw new Error("network down");
			return { id: "vid", url: "https://example.test/vid" };
		});
		const ctx = await makeContext([platform]);
		await drop(ctx, "clip.zip", { "video.mp4": VIDEO });

		expect((await runOnce(ctx)).results[0]?.outcome).toBe("retrying");
		expect((await listing(ctx)).inbox).toEqual([
			"clip.zip",
			"clip.zip.log.json",
		]);
		const afterFirst = await readResultLog(ctx.paths.inbox, "clip.zip");
		expect(afterFirst.status).toBe("retrying");
		expect(afterFirst.attempts[0]?.error).toContain("network down");

		expect((await runOnce(ctx)).results[0]?.outcome).toBe("done");
		const log = await readResultLog(ctx.paths.done, "clip.zip");
		expect(log.attempts.map((a) => a.outcome)).toEqual(["failure", "success"]);
		expect(log.uploaded.fake).toMatchObject({
			id: "vid",
			url: "https://example.test/vid",
			attempt: 2,
		});
	});

	it("moves the archive to failed/ after the second failure", async () => {
		const platform = fakePlatform("fake", failing());
		const ctx = await makeContext([platform]);
		await drop(ctx, "clip.zip", { "video.mp4": VIDEO });

		await runOnce(ctx);
		expect((await runOnce(ctx)).results[0]?.outcome).toBe("failed");

		expect(await listing(ctx)).toMatchObject({
			inbox: [],
			failed: ["clip.zip", "clip.zip.log.json"],
			work: [],
		});
		const log = await readResultLog(ctx.paths.failed, "clip.zip");
		expect(log.attempts).toHaveLength(2);
		expect(platform.calls).toHaveLength(2);
	});

	it("only retries the platforms that failed", async () => {
		const good = fakePlatform("good");
		const flaky = fakePlatform("flaky", (call) => {
			if (call === 1) throw new Error("quota exceeded");
			return { id: "ok" };
		});
		const ctx = await makeContext([good, flaky]);
		await drop(ctx, "clip.zip", { "video.mp4": VIDEO });

		await runOnce(ctx);
		await runOnce(ctx);

		expect(good.calls).toHaveLength(1);
		expect(flaky.calls).toHaveLength(2);
		const log = await readResultLog(ctx.paths.done, "clip.zip");
		expect(log.attempts[1]?.platforms.good).toMatchObject({
			status: "skipped",
		});
		expect(log.attempts[1]?.platforms.flaky).toMatchObject({
			status: "success",
		});
	});

	it.each<[string, Record<string, string>]>([
		["has no video", { "readme.txt": "?" }],
		[
			"has invalid metadata",
			{ "video.mp4": VIDEO, "metadata.yaml": "youtube:\n  privacy: pubic" },
		],
		[
			"names an unknown platform",
			{ "video.mp4": VIDEO, "metadata.yaml": "platforms: [tiktok]" },
		],
	])(
		"fails immediately without retrying when the archive %s",
		async (_case, files) => {
			const platform = fakePlatform("fake");
			const ctx = await makeContext([platform]);
			await drop(ctx, "bad.zip", files);

			expect((await runOnce(ctx)).results[0]?.outcome).toBe("failed");

			expect(platform.calls).toHaveLength(0);
			expect(await listing(ctx)).toMatchObject({
				inbox: [],
				failed: ["bad.zip", "bad.zip.log.json"],
				work: [],
			});
			expect(
				(await readResultLog(ctx.paths.failed, "bad.zip")).attempts,
			).toHaveLength(1);
		},
	);

	it("fails without uploading anywhere when a platform rejects the job", async () => {
		const ok = fakePlatform("ok");
		const strict = fakePlatform("strict", undefined, () => ["title too long"]);
		const ctx = await makeContext([ok, strict]);
		await drop(ctx, "clip.zip", { "video.mp4": VIDEO });

		await runOnce(ctx);

		expect(ok.calls).toHaveLength(0);
		const log = await readResultLog(ctx.paths.failed, "clip.zip");
		expect(log.attempts[0]?.error).toBe("strict: title too long");
	});

	it("recovers an archive left in processing/ by a crash", async () => {
		const platform = fakePlatform("fake");
		const ctx = await makeContext([platform]);
		await ensureDropDirs(ctx.paths);
		const stuck = await makeZip(path.join(ctx.paths.processing, "clip.zip"), {
			"video.mp4": VIDEO,
		});
		await writeLog(stuck, {
			archive: "clip.zip",
			status: "processing",
			attemptsInRound: 1,
			uploaded: {},
			attempts: [
				{
					attempt: 1,
					startedAt: "2026-11-20T10:00:00Z",
					warnings: [],
					platforms: {},
				},
			],
		});
		await writeFiles(ctx.paths.work, { "leftover/video.mp4": VIDEO });

		const summary = await runOnce(ctx);

		expect(summary.results).toEqual([{ archive: "clip.zip", outcome: "done" }]);
		expect((await listing(ctx)).work).toEqual([]);
		const log = await readResultLog(ctx.paths.done, "clip.zip");
		expect(log.attempts.map((a) => a.outcome)).toEqual([
			"interrupted",
			"success",
		]);
	});

	it("gives a failed archive a fresh round when it is dropped back in", async () => {
		const platform = fakePlatform("fake");
		const ctx = await makeContext([platform]);
		const file = await drop(ctx, "clip.zip", { "video.mp4": VIDEO });
		await writeLog(file, {
			archive: "clip.zip",
			status: "failed",
			attemptsInRound: 2,
			uploaded: {},
			attempts: [],
		});

		expect((await runOnce(ctx)).results[0]?.outcome).toBe("done");
		expect(platform.calls).toHaveLength(1);
	});

	it("does not overwrite an existing archive of the same name in done/", async () => {
		const ctx = await makeContext([fakePlatform("fake")]);
		await drop(ctx, "clip.zip", { "video.mp4": VIDEO });
		await runOnce(ctx);
		await drop(ctx, "clip.zip", { "video.mp4": VIDEO });
		await runOnce(ctx);

		const done = (await listing(ctx)).done;
		expect(done).toHaveLength(4);
		expect(done.filter((f) => f.endsWith(".zip")).sort()).toEqual([
			expect.stringMatching(/^clip-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.zip$/),
			"clip.zip",
		]);
	});
});

describe("half-copied archives", () => {
	it("retries an archive that was still being copied instead of failing it", async () => {
		const platform = fakePlatform("fake");
		const ctx = await makeContext([platform]);
		await ensureDropDirs(ctx.paths);
		const staging = await tempDir();
		const complete = await readFile(
			await makeZip(path.join(staging, "clip.zip"), {
				"video.mp4": VIDEO.repeat(1000),
			}),
		);
		// Windows sets the full size first, then fills in the data.
		const partial = Buffer.alloc(complete.length);
		complete.copy(partial, 0, 0, Math.floor(complete.length / 2));
		const inboxFile = path.join(ctx.paths.inbox, "clip.zip");
		await writeFile(inboxFile, partial);

		expect((await runOnce(ctx)).results[0]?.outcome).toBe("retrying");
		expect(platform.calls).toHaveLength(0);

		await writeFile(inboxFile, complete); // the copy finishes
		expect((await runOnce(ctx)).results[0]?.outcome).toBe("done");
		expect(platform.calls).toHaveLength(1);
	});
});

describe("scanInbox", () => {
	it("skips files that change during the wait and ignores non-archives", async () => {
		const inbox = await tempDir();
		await writeFiles(inbox, {
			"ready.zip": "x",
			"growing.zip": "x",
			"notes.txt": "x",
			"ready.zip.log.json": "{}",
		});
		const growing = path.join(inbox, "growing.zip");
		setTimeout(() => void appendFile(growing, "more"), 50);

		const scan = await scanInbox(inbox, 300);

		expect(scan.ready).toEqual([path.join(inbox, "ready.zip")]);
		expect(scan.changing).toEqual([growing]);
	});
});

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { youtube_v3 } from "@googleapis/youtube";
import { describe, expect, it } from "vitest";
import type { ResultLog } from "../src/job/result-log.js";
import { runOnce } from "../src/job/run.js";
import { silentLogger } from "../src/logger.js";
import { ensureDropDirs } from "../src/paths.js";
import type { UploadJob } from "../src/platforms/types.js";
import type { YoutubeApi } from "../src/platforms/youtube/api.js";
import { waitForAuthCode } from "../src/platforms/youtube/auth-flow.js";
import {
	loadClientSecret,
	readToken,
} from "../src/platforms/youtube/credentials.js";
import { describeYoutubeError } from "../src/platforms/youtube/errors.js";
import type { YoutubeOptions } from "../src/platforms/youtube/options.js";
import { createYoutubePlatform } from "../src/platforms/youtube/platform.js";
import {
	buildInsertParams,
	tagsLength,
	validateForYoutube,
} from "../src/platforms/youtube/resource.js";
import { makeContext, makeZip, tempDir, VIDEO, writeFiles } from "./helpers.js";

function job(
	overrides: Partial<UploadJob> = {},
	youtube?: YoutubeOptions,
): UploadJob {
	return {
		archiveName: "clip.zip",
		title: "Title",
		description: "Description",
		tags: [],
		video: "video.mp4",
		captions: [],
		metadata: youtube ? { youtube } : {},
		...overrides,
	};
}

/** Builds a Google API-style error as gaxios would throw it. */
function googleError(status: number, reason: string, message = reason) {
	return Object.assign(new Error(message), {
		response: { status, data: { error: { message, errors: [{ reason }] } } },
	});
}

interface FakeApi extends YoutubeApi {
	calls: string[];
}

function fakeApi(
	overrides: Partial<YoutubeApi> = {},
	video: youtube_v3.Schema$Video = {
		id: "abc123",
		status: { privacyStatus: "private" },
	},
): FakeApi {
	const calls: string[] = [];
	return {
		calls,
		insertVideo: async (params) => {
			calls.push(`insert ${params.requestBody?.snippet?.title}`);
			return video;
		},
		setThumbnail: async (id, file, mime) => {
			calls.push(`thumbnail ${id} ${path.basename(file)} ${mime}`);
		},
		insertCaption: async (id, lang) => {
			calls.push(`caption ${id} ${lang}`);
		},
		addToPlaylist: async (playlist, id) => {
			calls.push(`playlist ${playlist} ${id}`);
		},
		...overrides,
	};
}

describe("tagsLength", () => {
	it("counts commas between tags and quotes around tags with spaces", () => {
		expect(tagsLength([])).toBe(0);
		expect(tagsLength(["a", "bc"])).toBe(4); // a,bc
		expect(tagsLength(["two words", "x"])).toBe(13); // "two words",x
	});
});

describe("validateForYoutube", () => {
	it("accepts a normal job", async () => {
		expect(await validateForYoutube(job())).toEqual([]);
	});

	it.each<[string, UploadJob, string]>([
		[
			"a long title",
			job({ title: "x".repeat(101) }),
			"title is 101 characters",
		],
		[
			"angle brackets in the title",
			job({ title: "a <b>" }),
			"title must not contain",
		],
		[
			"a long description",
			job({ description: "é".repeat(2501) }),
			"description is 5002 bytes",
		],
		[
			"too many tags",
			job({ tags: Array.from({ length: 60 }, (_, i) => `tag-number-${i}`) }),
			"tags total",
		],
		[
			"localizations without a default language",
			job({}, { localizations: { es: { title: "Hola" } } }),
			"defaultLanguage",
		],
		[
			"a past publishAt",
			job({}, { publishAt: "2020-01-01T00:00:00Z" }),
			"in the past",
		],
	])("rejects %s", async (_name, input, message) => {
		expect((await validateForYoutube(input)).join("\n")).toContain(message);
	});

	it("rejects a thumbnail over 2 MiB", async () => {
		const dir = await tempDir();
		await writeFiles(dir, { "thumbnail.jpg": "x".repeat(2 * 1024 * 1024 + 1) });
		const problems = await validateForYoutube(
			job({ thumbnail: path.join(dir, "thumbnail.jpg") }),
		);
		expect(problems.join()).toContain("limit is 2 MiB");
	});
});

describe("buildInsertParams", () => {
	it("defaults to private in People & Blogs and leaves unset options out", () => {
		const params = buildInsertParams(job());
		expect(params).toEqual({
			part: ["snippet", "status"],
			requestBody: {
				snippet: {
					title: "Title",
					description: "Description",
					categoryId: "22",
				},
				status: { privacyStatus: "private" },
			},
		});
	});

	it("maps every option", () => {
		const params = buildInsertParams(
			job(
				{ tags: ["a"] },
				{
					privacy: "public",
					categoryId: "20",
					madeForKids: false,
					containsSyntheticMedia: true,
					notifySubscribers: false,
					embeddable: false,
					publicStatsViewable: true,
					license: "creativeCommon",
					defaultLanguage: "en",
					defaultAudioLanguage: "en-US",
					recordingDate: "2026-11-15",
					localizations: { es: { title: "Hola" } },
				},
			),
		);
		expect(params).toEqual({
			part: ["snippet", "status", "recordingDetails", "localizations"],
			notifySubscribers: false,
			requestBody: {
				snippet: {
					title: "Title",
					description: "Description",
					tags: ["a"],
					categoryId: "20",
					defaultLanguage: "en",
					defaultAudioLanguage: "en-US",
				},
				status: {
					privacyStatus: "public",
					license: "creativeCommon",
					embeddable: false,
					publicStatsViewable: true,
					selfDeclaredMadeForKids: false,
					containsSyntheticMedia: true,
				},
				recordingDetails: { recordingDate: "2026-11-15T00:00:00Z" },
				localizations: { es: { title: "Hola", description: "Description" } },
			},
		});
	});

	it("forces private when publishAt is set", () => {
		const params = buildInsertParams(
			job({}, { publishAt: "2030-01-01T00:00:00Z" }),
		);
		expect(params.requestBody?.status).toEqual({
			privacyStatus: "private",
			publishAt: "2030-01-01T00:00:00Z",
		});
	});
});

describe("youtube platform upload", () => {
	it("uploads, then sets the thumbnail, captions and playlists", async () => {
		const api = fakeApi();
		const platform = createYoutubePlatform(async () => api);
		const result = await platform.upload(
			job(
				{
					thumbnail: "/x/thumbnail.PNG",
					captions: [{ language: "en", format: "srt", path: "/x/en.srt" }],
				},
				{ playlists: ["PL1", "PL2"] },
			),
			silentLogger,
		);

		expect(result).toEqual({
			id: "abc123",
			url: "https://youtu.be/abc123",
			warnings: [],
		});
		expect(api.calls).toEqual([
			"insert Title",
			"thumbnail abc123 thumbnail.PNG image/png",
			"caption abc123 en",
			"playlist PL1 abc123",
			"playlist PL2 abc123",
		]);
	});

	it("turns failures after the video exists into warnings instead of errors", async () => {
		const api = fakeApi({
			setThumbnail: async () => {
				throw googleError(403, "forbidden");
			},
		});
		const platform = createYoutubePlatform(async () => api);
		const result = await platform.upload(
			job({ thumbnail: "/x/thumbnail.jpg" }, { playlists: ["PL1"] }),
			silentLogger,
		);

		expect(result.id).toBe("abc123");
		expect(result.warnings).toEqual([
			expect.stringContaining("thumbnail failed: YouTube refused the request"),
		]);
		expect(api.calls).toContain("playlist PL1 abc123");
	});

	it("warns when YouTube locks the video to private", async () => {
		const api = fakeApi(
			{},
			{ id: "abc123", status: { privacyStatus: "private" } },
		);
		const platform = createYoutubePlatform(async () => api);
		const result = await platform.upload(
			job({}, { privacy: "public" }),
			silentLogger,
		);
		expect(result.warnings?.[0]).toContain('requested privacy "public"');
	});

	it("reports a quota error readably", async () => {
		const api = fakeApi({
			insertVideo: async () => {
				throw googleError(403, "quotaExceeded");
			},
		});
		const platform = createYoutubePlatform(async () => api);
		await expect(platform.upload(job(), silentLogger)).rejects.toThrow(
			"YouTube API daily quota is used up",
		);
	});
});

describe("describeYoutubeError", () => {
	it("explains an expired refresh token", () => {
		const error = Object.assign(new Error("invalid_grant"), {
			response: { status: 400, data: { error: "invalid_grant" } },
		});
		expect(describeYoutubeError(error)).toContain("npm run auth:youtube");
	});

	it("falls back to status, reason and message", () => {
		expect(
			describeYoutubeError(googleError(400, "invalidTitle", "Bad title")),
		).toBe("400 invalidTitle: Bad title");
		expect(describeYoutubeError(new Error("socket hang up"))).toBe(
			"socket hang up",
		);
	});
});

describe("credentials", () => {
	it("rejects a client file that is not a Desktop app client", async () => {
		const dir = await tempDir();
		await writeFiles(dir, {
			"client.json": JSON.stringify({ web: { client_id: "x" } }),
		});
		await expect(
			loadClientSecret(path.join(dir, "client.json")),
		).rejects.toThrow("Desktop app");
	});

	it("loads a Desktop app client file", async () => {
		const dir = await tempDir();
		await writeFiles(dir, {
			"client.json": JSON.stringify({
				installed: { client_id: "id", client_secret: "secret" },
			}),
		});
		expect(await loadClientSecret(path.join(dir, "client.json"))).toEqual({
			clientId: "id",
			clientSecret: "secret",
		});
	});

	it("tells you to run the auth command when there is no token", async () => {
		await expect(readToken("/nonexistent/token.json")).rejects.toThrow(
			"npm run auth:youtube",
		);
	});
});

describe("waitForAuthCode", () => {
	async function withServer<T>(
		fn: (base: string, server: ReturnType<typeof createServer>) => Promise<T>,
	) {
		const server = createServer();
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		try {
			return await fn(`http://127.0.0.1:${port}`, server);
		} finally {
			server.close();
		}
	}

	it("ignores requests with the wrong state and resolves with the code", async () => {
		await withServer(async (base, server) => {
			const pending = waitForAuthCode(server, "s3cret", 5000);
			expect((await fetch(`${base}/?state=wrong&code=evil`)).status).toBe(400);
			expect((await fetch(`${base}/favicon.ico`)).status).toBe(400);
			expect((await fetch(`${base}/?state=s3cret&code=good`)).status).toBe(200);
			expect(await pending).toBe("good");
		});
	});

	it("rejects when Google reports an error", async () => {
		await withServer(async (base, server) => {
			const pending = waitForAuthCode(server, "s", 5000);
			const assertion = expect(pending).rejects.toThrow("access_denied");
			await fetch(`${base}/?state=s&error=access_denied`);
			await assertion;
		});
	});
});

describe("runOnce with the youtube platform", () => {
	it("records the video URL, and retries a quota failure on the next run", async () => {
		let attempt = 0;
		const api = fakeApi({
			insertVideo: async () => {
				attempt++;
				if (attempt === 1) throw googleError(403, "quotaExceeded");
				return { id: "vid1", status: { privacyStatus: "private" } };
			},
		});
		const ctx = await makeContext([createYoutubePlatform(async () => api)]);
		await ensureDropDirs(ctx.paths);
		await makeZip(path.join(ctx.paths.inbox, "clip.zip"), {
			"video.mp4": VIDEO,
		});

		expect((await runOnce(ctx)).results[0]?.outcome).toBe("retrying");
		expect((await runOnce(ctx)).results[0]?.outcome).toBe("done");

		const log = JSON.parse(
			await readFile(path.join(ctx.paths.done, "clip.zip.log.json"), "utf8"),
		) as ResultLog;
		expect(log.attempts[0]?.error).toContain("quota is used up");
		expect(log.uploaded.youtube).toMatchObject({
			id: "vid1",
			url: "https://youtu.be/vid1",
		});
	});
});

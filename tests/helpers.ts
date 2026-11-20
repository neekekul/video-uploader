import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { c as tarCreate } from "tar";
import { afterEach } from "vitest";
import yazl from "yazl";
import type { Config } from "../src/config.js";
import type { JobContext } from "../src/job/process-archive.js";
import { silentLogger } from "../src/logger.js";
import { dropPaths } from "../src/paths.js";
import type {
	Platform,
	UploadJob,
	UploadResult,
} from "../src/platforms/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
	);
});

export async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "video-uploader-test-"));
	tempDirs.push(dir);
	return dir;
}

export type Files = Record<string, string>;

/** Writes `files` (relative path → content) under `dir`. */
export async function writeFiles(dir: string, files: Files): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		const full = path.join(dir, name);
		await mkdir(path.dirname(full), { recursive: true });
		await writeFile(full, content);
	}
}

export async function makeZip(file: string, files: Files): Promise<string> {
	const zip = new yazl.ZipFile();
	for (const [name, content] of Object.entries(files)) {
		zip.addBuffer(Buffer.from(content), name);
	}
	zip.end();
	await pipeline(zip.outputStream, createWriteStream(file));
	return file;
}

export async function makeTarGz(file: string, files: Files): Promise<string> {
	const staging = await tempDir();
	await writeFiles(staging, files);
	await tarCreate({ gzip: true, file, cwd: staging }, Object.keys(files));
	return file;
}

export const VIDEO = "fake mp4 bytes";

export interface FakePlatform extends Platform {
	calls: UploadJob[];
}

/** A platform whose upload result is decided per call by `behave` (throw to fail). */
export function fakePlatform(
	name: string,
	behave: (call: number) => UploadResult = (call) => ({
		id: `${name}-${call}`,
	}),
	validate: (job: UploadJob) => string[] = () => [],
): FakePlatform {
	const calls: UploadJob[] = [];
	return {
		name,
		calls,
		validate,
		async upload(job) {
			calls.push(job);
			return behave(calls.length);
		},
	};
}

export async function makeContext(
	platforms: Platform[],
	overrides: Partial<Config> = {},
): Promise<JobContext> {
	const root = await tempDir();
	const config: Config = {
		dropDir: path.join(root, "drop"),
		configDir: path.join(root, "config"),
		schedule: "0 */2 * * *",
		runOnStart: false,
		stabilityWaitMs: 0,
		maxAttempts: 2,
		defaultPlatforms: platforms.map((p) => p.name),
		...overrides,
	};
	await mkdir(config.configDir, { recursive: true });
	return {
		config,
		paths: dropPaths(config.dropDir),
		platforms: new Map(platforms.map((p) => [p.name, p])),
		logger: silentLogger,
	};
}

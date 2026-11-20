import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { c as tarCreate } from "tar";
import { describe, expect, it } from "vitest";
import { extractArchive, safeJoin } from "../src/archive/extract.js";
import { parseArchiveName } from "../src/archive/formats.js";
import { inspectArchive } from "../src/archive/inspect.js";
import { ValidationError } from "../src/errors.js";
import { makeTarGz, makeZip, tempDir, VIDEO, writeFiles } from "./helpers.js";

describe("parseArchiveName", () => {
	it.each([
		["My Video.zip", "zip", "My Video"],
		["clip.tar.gz", "tar.gz", "clip"],
		["CLIP.TGZ", "tar.gz", "CLIP"],
	])("parses %s", (name, format, baseName) => {
		expect(parseArchiveName(name)).toEqual({ format, baseName });
	});

	it.each(["video.mp4", "notes.txt", ".zip", "a.zip.log.json", "x.tar"])(
		"rejects %s",
		(name) => {
			expect(parseArchiveName(name)).toBeNull();
		},
	);
});

describe("safeJoin", () => {
	const root = path.resolve("/tmp/work");

	it("allows nested paths", () => {
		expect(safeJoin(root, "folder/video.mp4")).toBe(
			path.join(root, "folder", "video.mp4"),
		);
	});

	it.each([
		"../evil.txt",
		"a/../../evil.txt",
		"/etc/passwd",
		"C:/evil.txt",
		"..\\evil.txt",
	])("rejects %s", (entry) => {
		expect(() => safeJoin(root, entry)).toThrow(ValidationError);
	});
});

describe("extractArchive", () => {
	it("extracts a zip", async () => {
		const dir = await tempDir();
		const zip = await makeZip(path.join(dir, "a.zip"), {
			"video.mp4": VIDEO,
			"sub/description.txt": "hello",
		});
		const dest = path.join(dir, "out");
		await extractArchive(zip, "zip", dest);
		expect(await readFile(path.join(dest, "video.mp4"), "utf8")).toBe(VIDEO);
		expect(
			await readFile(path.join(dest, "sub", "description.txt"), "utf8"),
		).toBe("hello");
	});

	it("extracts a tar.gz", async () => {
		const dir = await tempDir();
		const tgz = await makeTarGz(path.join(dir, "a.tar.gz"), {
			"clip/video.mp4": VIDEO,
		});
		const dest = path.join(dir, "out");
		await extractArchive(tgz, "tar.gz", dest);
		expect(await readFile(path.join(dest, "clip", "video.mp4"), "utf8")).toBe(
			VIDEO,
		);
	});

	it("does not write outside the destination for a tar entry with ..", async () => {
		const dir = await tempDir();
		await writeFiles(dir, { "evil.txt": "pwned", "inner/video.mp4": VIDEO });
		const tgz = path.join(dir, "evil.tar.gz");
		await tarCreate(
			{
				gzip: true,
				file: tgz,
				cwd: path.join(dir, "inner"),
				preservePaths: true,
			},
			["video.mp4", "../evil.txt"],
		);
		const dest = path.join(dir, "deep", "out");
		await expect(extractArchive(tgz, "tar.gz", dest)).rejects.toThrow(
			"escapes the extraction folder",
		);
		await expect(access(path.join(dir, "deep", "evil.txt"))).rejects.toThrow();
	});

	it("reports an unreadable archive as a retryable error", async () => {
		const dir = await tempDir();
		await writeFiles(dir, { "bad.zip": "not a zip" });
		const error = await extractArchive(
			path.join(dir, "bad.zip"),
			"zip",
			path.join(dir, "out"),
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ValidationError);
		expect((error as Error).message).toContain("will be retried");
	});
});

describe("inspectArchive", () => {
	it("finds every recognised file", async () => {
		const dir = await tempDir();
		await writeFiles(dir, {
			"Video.MP4": VIDEO,
			"description.txt": "d",
			"metadata.yaml": "title: x",
			"thumbnail.png": "img",
			"en.srt": "1",
			"pt-BR.vtt": "1",
			"notes.md": "?",
		});
		const contents = await inspectArchive(dir);
		expect(contents.video).toBe(path.join(dir, "Video.MP4"));
		expect(contents.descriptionFile).toBe(path.join(dir, "description.txt"));
		expect(contents.metadataFile).toBe(path.join(dir, "metadata.yaml"));
		expect(contents.thumbnail).toBe(path.join(dir, "thumbnail.png"));
		expect(contents.captions.map((c) => [c.language, c.format]).sort()).toEqual(
			[
				["en", "srt"],
				["pt-BR", "vtt"],
			],
		);
		expect(contents.warnings).toEqual(["Ignored unrecognised file: notes.md"]);
	});

	it("looks inside a single top-level folder and ignores OS junk", async () => {
		const dir = await tempDir();
		await writeFiles(dir, {
			"My Video/video.mp4": VIDEO,
			"__MACOSX/._video.mp4": "",
			".DS_Store": "",
		});
		const contents = await inspectArchive(dir);
		expect(contents.root).toBe(path.join(dir, "My Video"));
	});

	it.each<[string, Record<string, string>, string]>([
		["no video", { "description.txt": "d" }, "no .mp4"],
		["two videos", { "a.mp4": VIDEO, "b.mp4": VIDEO }, "2 .mp4 files"],
		[
			"two metadata files",
			{ "a.mp4": VIDEO, "metadata.yaml": "", "metadata.json": "{}" },
			"more than one metadata",
		],
		[
			"two thumbnails",
			{ "a.mp4": VIDEO, "thumbnail.jpg": "", "thumbnail.png": "" },
			"more than one thumbnail",
		],
		[
			"badly named captions",
			{ "a.mp4": VIDEO, "english subs.srt": "" },
			"named after its language",
		],
		[
			"duplicate caption language",
			{ "a.mp4": VIDEO, "en.srt": "", "en.vtt": "" },
			'language "en"',
		],
	])("rejects %s", async (_name, files, message) => {
		const dir = await tempDir();
		await writeFiles(dir, files);
		await expect(inspectArchive(dir)).rejects.toThrow(message);
	});
});

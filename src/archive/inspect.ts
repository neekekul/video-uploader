import { readdir } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "../errors.js";

export interface CaptionFile {
	/** BCP-47 language tag taken from the file name, e.g. `en` or `pt-BR`. */
	language: string;
	format: "srt" | "vtt";
	path: string;
}

export interface ArchiveContents {
	/** Folder the files below were found in. */
	root: string;
	video: string;
	descriptionFile?: string;
	metadataFile?: string;
	thumbnail?: string;
	captions: CaptionFile[];
	/** Non-fatal issues, e.g. unrecognised files that were ignored. */
	warnings: string[];
}

const JUNK = new Set(["__macosx", ".ds_store", "thumbs.db", "desktop.ini"]);
const METADATA_NAMES = new Set([
	"metadata.yaml",
	"metadata.yml",
	"metadata.json",
]);
const THUMBNAIL_NAMES = new Set([
	"thumbnail.jpg",
	"thumbnail.jpeg",
	"thumbnail.png",
]);
const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

function isJunk(name: string): boolean {
	return JUNK.has(name.toLowerCase()) || name.startsWith("._");
}

/**
 * Finds the recognised files in an extracted archive. Files may sit at the
 * archive root or inside a single top-level folder; deeper nesting is ignored.
 */
export async function inspectArchive(
	extractedDir: string,
): Promise<ArchiveContents> {
	const root = await findContentRoot(extractedDir);
	const entries = (await readdir(root, { withFileTypes: true })).filter(
		(e) => !isJunk(e.name),
	);

	const problems: string[] = [];
	const warnings: string[] = [];
	const videos: string[] = [];
	const metadata: string[] = [];
	const thumbnails: string[] = [];
	const captions: CaptionFile[] = [];
	let descriptionFile: string | undefined;

	for (const entry of entries) {
		const name = entry.name;
		const lower = name.toLowerCase();
		const full = path.join(root, name);

		if (!entry.isFile()) {
			warnings.push(`Ignored folder: ${name}`);
		} else if (lower.endsWith(".mp4")) {
			videos.push(full);
		} else if (lower === "description.txt") {
			descriptionFile = full;
		} else if (METADATA_NAMES.has(lower)) {
			metadata.push(full);
		} else if (THUMBNAIL_NAMES.has(lower)) {
			thumbnails.push(full);
		} else if (lower.endsWith(".srt") || lower.endsWith(".vtt")) {
			const language = name.slice(0, -4);
			if (!LANGUAGE_TAG.test(language)) {
				problems.push(
					`Caption file "${name}" must be named after its language, e.g. en.srt or pt-BR.vtt`,
				);
			} else if (
				captions.some(
					(c) => c.language.toLowerCase() === language.toLowerCase(),
				)
			) {
				problems.push(`More than one caption file for language "${language}"`);
			} else {
				captions.push({
					language,
					format: lower.endsWith(".srt") ? "srt" : "vtt",
					path: full,
				});
			}
		} else {
			warnings.push(`Ignored unrecognised file: ${name}`);
		}
	}

	if (videos.length === 0) problems.push("Archive contains no .mp4 file");
	if (videos.length > 1) {
		problems.push(
			`Archive contains ${videos.length} .mp4 files; expected exactly one`,
		);
	}
	if (metadata.length > 1)
		problems.push("Archive contains more than one metadata file");
	if (thumbnails.length > 1)
		problems.push("Archive contains more than one thumbnail");

	const [video] = videos;
	if (problems.length > 0 || video === undefined)
		throw new ValidationError(problems);

	const contents: ArchiveContents = { root, video, captions, warnings };
	if (descriptionFile) contents.descriptionFile = descriptionFile;
	if (metadata[0]) contents.metadataFile = metadata[0];
	if (thumbnails[0]) contents.thumbnail = thumbnails[0];
	return contents;
}

async function findContentRoot(dir: string): Promise<string> {
	const entries = (await readdir(dir, { withFileTypes: true })).filter(
		(e) => !isJunk(e.name),
	);
	const [only] = entries;
	if (entries.length === 1 && only?.isDirectory()) {
		return path.join(dir, only.name);
	}
	return dir;
}

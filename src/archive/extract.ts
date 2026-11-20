import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ReadEntry, x as tarExtract } from "tar";
import yauzl from "yauzl";
import { errorMessage, ValidationError } from "../errors.js";
import type { ArchiveFormat } from "./formats.js";

/**
 * Resolves an archive entry name inside `root`, rejecting anything that would
 * land outside it (absolute paths, drive letters, `..` segments).
 */
export function safeJoin(root: string, entryName: string): string {
	const normalized = entryName.replaceAll("\\", "/");
	if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
		throw new ValidationError([
			`Archive entry has an absolute path: ${entryName}`,
		]);
	}
	const resolvedRoot = path.resolve(root);
	const target = path.resolve(resolvedRoot, normalized);
	const relative = path.relative(resolvedRoot, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new ValidationError([
			`Archive entry escapes the extraction folder: ${entryName}`,
		]);
	}
	return target;
}

export async function extractArchive(
	file: string,
	format: ArchiveFormat,
	dest: string,
): Promise<void> {
	await mkdir(dest, { recursive: true });
	try {
		if (format === "zip") {
			await extractZip(file, dest);
		} else {
			await extractTarGz(file, dest);
		}
	} catch (error) {
		// Unsafe entries are permanent failures.
		if (error instanceof ValidationError) throw error;
		// Anything else is retryable: the archive may simply not have finished
		// copying. Windows sets the full file size the moment a copy starts, and
		// inside a container the host's file lock isn't visible, so a half-copied
		// archive can slip past the stability check. A truly corrupt archive fails
		// again on the retry and then goes to failed/.
		throw new Error(
			`Could not extract archive (it may still have been copying; it will be retried): ${errorMessage(error)}`,
		);
	}
}

async function extractZip(file: string, dest: string): Promise<void> {
	// autoClose is off so the file handle is always released in `finally`, even
	// when we abort mid-way. An open handle would block moving the archive on Windows.
	const zip = await yauzl.openPromise(file, {
		lazyEntries: true,
		autoClose: false,
	});
	try {
		await new Promise<void>((resolve, reject) => {
			zip.on("error", reject);
			zip.on("end", () => resolve());
			zip.on("entry", (entry: yauzl.Entry) => {
				writeZipEntry(zip, entry, dest).then(() => zip.readEntry(), reject);
			});
			zip.readEntry();
		});
	} finally {
		zip.close();
	}
}

async function writeZipEntry(
	zip: yauzl.ZipFile,
	entry: yauzl.Entry,
	dest: string,
): Promise<void> {
	const target = safeJoin(dest, entry.fileName);
	if (entry.fileName.endsWith("/")) {
		await mkdir(target, { recursive: true });
		return;
	}
	await mkdir(path.dirname(target), { recursive: true });
	const stream = await zip.openReadStreamPromise(entry);
	await pipeline(stream, createWriteStream(target));
}

const ALLOWED_TAR_TYPES = new Set([
	"File",
	"OldFile",
	"ContiguousFile",
	"Directory",
]);

async function extractTarGz(file: string, dest: string): Promise<void> {
	// Errors thrown inside `filter` escape tar's promise, so collect them and
	// throw once extraction has finished.
	const problems: string[] = [];
	await tarExtract({
		file,
		cwd: dest,
		strict: true,
		filter: (entryPath, entry) => {
			// Links and device files are never needed and are the usual escape route.
			if (entry instanceof ReadEntry && !ALLOWED_TAR_TYPES.has(entry.type)) {
				return false;
			}
			try {
				safeJoin(dest, entryPath);
				return true;
			} catch (error) {
				problems.push(errorMessage(error));
				return false;
			}
		},
	});
	if (problems.length > 0) throw new ValidationError(problems);
}

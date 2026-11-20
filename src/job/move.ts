import { access, rename } from "node:fs/promises";
import path from "node:path";
import { parseArchiveName } from "../archive/formats.js";
import { logPathFor } from "./result-log.js";

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

/** Picks a free path in `dir`, adding a timestamp before the extension if the name is taken. */
export async function uniqueDestination(
	dir: string,
	fileName: string,
): Promise<string> {
	const first = path.join(dir, fileName);
	if (!(await exists(first))) return first;

	const parsed = parseArchiveName(fileName);
	const base = parsed ? parsed.baseName : fileName;
	const suffix = parsed ? fileName.slice(parsed.baseName.length) : "";
	const stamp = new Date()
		.toISOString()
		.replaceAll(":", "-")
		.replace(/\.\d+Z$/, "Z");
	for (let n = 0; ; n++) {
		const candidate = path.join(
			dir,
			`${base}-${stamp}${n === 0 ? "" : `-${n}`}${suffix}`,
		);
		if (!(await exists(candidate))) return candidate;
	}
}

/** Moves an archive and its result log (if any) into `destDir`. Returns the new archive path. */
export async function moveArchive(
	archivePath: string,
	destDir: string,
): Promise<string> {
	const dest = await uniqueDestination(destDir, path.basename(archivePath));
	await rename(archivePath, dest);
	const log = logPathFor(archivePath);
	if (await exists(log)) {
		await rename(log, logPathFor(dest));
	}
	return dest;
}

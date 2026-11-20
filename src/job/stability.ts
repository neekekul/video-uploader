import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArchiveName } from "../archive/formats.js";

interface Snapshot {
	file: string;
	size: number;
	mtimeMs: number;
}

async function snapshot(file: string): Promise<Snapshot | null> {
	try {
		const s = await stat(file);
		return s.isFile() ? { file, size: s.size, mtimeMs: s.mtimeMs } : null;
	} catch {
		return null;
	}
}

export interface InboxScan {
	/** Archives whose size and mtime did not change during the wait, oldest first. */
	ready: string[];
	/** Archives that are probably still being copied in. */
	changing: string[];
}

/**
 * Lists supported archives in the inbox and keeps only those that look fully
 * copied: size and mtime are sampled twice, `waitMs` apart, and must match.
 */
export async function scanInbox(
	inbox: string,
	waitMs: number,
): Promise<InboxScan> {
	const names = (await readdir(inbox)).filter(
		(name) => parseArchiveName(name) !== null,
	);
	const before = (
		await Promise.all(names.map((n) => snapshot(path.join(inbox, n))))
	).filter((s): s is Snapshot => s !== null);
	if (before.length === 0) return { ready: [], changing: [] };
	if (waitMs > 0) await sleep(waitMs);

	const ready: Snapshot[] = [];
	const changing: string[] = [];
	for (const first of before) {
		const second = await snapshot(first.file);
		if (
			second &&
			second.size === first.size &&
			second.mtimeMs === first.mtimeMs
		) {
			ready.push(second);
		} else if (second) {
			changing.push(first.file);
		}
	}
	ready.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
	return { ready: ready.map((s) => s.file), changing };
}

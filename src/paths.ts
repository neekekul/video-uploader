import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface DropPaths {
	inbox: string;
	processing: string;
	done: string;
	failed: string;
	work: string;
}

export function dropPaths(dropDir: string): DropPaths {
	return {
		inbox: path.join(dropDir, "inbox"),
		processing: path.join(dropDir, "processing"),
		done: path.join(dropDir, "done"),
		failed: path.join(dropDir, "failed"),
		work: path.join(dropDir, "work"),
	};
}

export async function ensureDropDirs(paths: DropPaths): Promise<void> {
	for (const dir of Object.values(paths)) {
		await mkdir(dir, { recursive: true });
	}
}

import { rmSync } from "node:fs";
import { open, readFile, rm, stat, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

export const LOCK_FILE = ".lock";

/** Lock files held by this process, so a signal handler can release them before exiting. */
const held = new Set<string>();

/**
 * Removes every lock this process holds. Synchronous so it can run in a signal
 * handler right before `process.exit`; without it a quick restart would see a
 * fresh-looking lock and skip its first run.
 */
export function releaseHeldLocksSync(): void {
	for (const lockPath of held) rmSync(lockPath, { force: true });
	held.clear();
}

export interface LockOptions {
	/** How often the holder refreshes the lock's mtime. */
	heartbeatMs?: number;
	/** A lock whose mtime is older than this is considered abandoned. */
	staleMs?: number;
}

export interface DropLock {
	release(): Promise<void>;
}

export interface LockHolder {
	pid: number;
	host: string;
	acquiredAt: string;
}

export type AcquireResult =
	| { acquired: true; lock: DropLock; tookOverStale: boolean }
	| { acquired: false; holder: LockHolder | undefined };

/**
 * Takes an exclusive lock on the drop folder so two instances (e.g. the
 * container and a manual `run-once`) never process it at the same time.
 *
 * PIDs aren't meaningful across containers and hosts, so liveness is tracked
 * with a heartbeat instead. The holder touches the file every `heartbeatMs`,
 * and a lock that hasn't been touched for `staleMs` is treated as left over
 * from a crash and taken over.
 */
export async function acquireDropLock(
	dropDir: string,
	{ heartbeatMs = 30_000, staleMs = 120_000 }: LockOptions = {},
): Promise<AcquireResult> {
	const lockPath = path.join(dropDir, LOCK_FILE);
	let tookOverStale = false;

	for (let tries = 0; tries < 2; tries++) {
		const holder: LockHolder = {
			pid: process.pid,
			host: hostname(),
			acquiredAt: new Date().toISOString(),
		};
		try {
			const handle = await open(lockPath, "wx");
			try {
				await handle.writeFile(`${JSON.stringify(holder, null, "\t")}\n`);
			} finally {
				await handle.close();
			}
			return {
				acquired: true,
				lock: startHeartbeat(lockPath, heartbeatMs),
				tookOverStale,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		const age = await lockAge(lockPath);
		if (age === undefined) continue; // Released between our attempts; try again.
		if (age < staleMs) {
			return { acquired: false, holder: await readHolder(lockPath) };
		}
		await rm(lockPath, { force: true });
		tookOverStale = true;
	}
	return { acquired: false, holder: await readHolder(lockPath) };
}

function startHeartbeat(lockPath: string, heartbeatMs: number): DropLock {
	const timer = setInterval(() => {
		const now = new Date();
		utimes(lockPath, now, now).catch(() => {});
	}, heartbeatMs);
	// Don't keep the process alive just for the heartbeat.
	timer.unref();
	held.add(lockPath);

	let released = false;
	return {
		async release() {
			if (released) return;
			released = true;
			clearInterval(timer);
			held.delete(lockPath);
			await rm(lockPath, { force: true });
		},
	};
}

async function lockAge(lockPath: string): Promise<number | undefined> {
	try {
		return Date.now() - (await stat(lockPath)).mtimeMs;
	} catch {
		return undefined;
	}
}

async function readHolder(lockPath: string): Promise<LockHolder | undefined> {
	try {
		return JSON.parse(await readFile(lockPath, "utf8")) as LockHolder;
	} catch {
		return undefined;
	}
}

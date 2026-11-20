import { readFile, writeFile } from "node:fs/promises";

/**
 * - processing: a job is working on it (or crashed while doing so)
 * - retrying:   failed, back in inbox/ for another attempt on the next run
 * - waiting:    a platform wasn't ready (e.g. expired sign-in); back in inbox/
 *               without using an attempt
 * - done / failed: final
 */
export type JobStatus =
	| "processing"
	| "retrying"
	| "waiting"
	| "done"
	| "failed";

export type PlatformAttemptResult =
	| { status: "success"; id: string; url?: string }
	| { status: "failure"; error: string }
	| { status: "skipped"; reason: string };

export interface AttemptRecord {
	/** 1-based, counted across the archive's whole history. */
	attempt: number;
	startedAt: string;
	/** Missing if the app stopped mid-attempt. */
	finishedAt?: string;
	/** "deferred" means a platform wasn't ready; it doesn't count as an attempt. */
	outcome?: "success" | "failure" | "interrupted" | "deferred";
	title?: string;
	error?: string;
	warnings: string[];
	platforms: Record<string, PlatformAttemptResult>;
}

export interface UploadedRecord {
	id: string;
	url?: string;
	attempt: number;
	uploadedAt: string;
}

/**
 * Stored next to the archive as `<archive>.log.json` and moved with it.
 * It is also the job's state: `uploaded` is what makes retries skip platforms
 * that already succeeded.
 */
export interface ResultLog {
	archive: string;
	status: JobStatus;
	/** Attempts since the archive was last (re)queued. Reset when a finished archive is dropped in again. */
	attemptsInRound: number;
	uploaded: Record<string, UploadedRecord>;
	attempts: AttemptRecord[];
}

export function logPathFor(archivePath: string): string {
	return `${archivePath}.log.json`;
}

export async function readLog(
	archivePath: string,
	archiveName: string,
): Promise<ResultLog> {
	try {
		const parsed = JSON.parse(
			await readFile(logPathFor(archivePath), "utf8"),
		) as ResultLog;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			Array.isArray(parsed.attempts)
		) {
			return parsed;
		}
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "ENOENT" &&
			!(error instanceof SyntaxError)
		) {
			throw error;
		}
	}
	return {
		archive: archiveName,
		status: "processing",
		attemptsInRound: 0,
		uploaded: {},
		attempts: [],
	};
}

export async function writeLog(
	archivePath: string,
	log: ResultLog,
): Promise<void> {
	await writeFile(
		logPathFor(archivePath),
		`${JSON.stringify(log, null, "\t")}\n`,
		"utf8",
	);
}

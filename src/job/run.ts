import { readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parseArchiveName } from "../archive/formats.js";
import { errorMessage } from "../errors.js";
import { ensureDropDirs } from "../paths.js";
import { moveArchive } from "./move.js";
import {
	type ArchiveOutcome,
	type JobContext,
	processArchive,
} from "./process-archive.js";
import { logPathFor, readLog, writeLog } from "./result-log.js";
import { scanInbox } from "./stability.js";

export interface RunSummary {
	results: { archive: string; outcome: ArchiveOutcome }[];
	/** Archives left in inbox/ because they were still being copied or were locked. */
	skipped: string[];
}

/**
 * One pass over the inbox. Assumes it is the only process using the drop
 * folder: anything left in processing/ or work/ is treated as a crash leftover.
 */
export async function runOnce(ctx: JobContext): Promise<RunSummary> {
	const { paths, logger } = ctx;
	await ensureDropDirs(paths);
	await recoverInterrupted(ctx);
	await clearWorkDir(ctx);

	const scan = await scanInbox(paths.inbox, ctx.config.stabilityWaitMs);
	const summary: RunSummary = {
		results: [],
		skipped: scan.changing.map((f) => path.basename(f)),
	};
	for (const file of scan.changing) {
		logger.info(`Skipping ${path.basename(file)}: still being copied`);
	}
	if (scan.ready.length === 0) {
		logger.info("No archives ready in inbox");
		return summary;
	}

	for (const inboxPath of scan.ready) {
		const name = path.basename(inboxPath);
		const claimed = path.join(paths.processing, name);
		try {
			// Claiming by rename fails if another program still has the file open,
			// which is the case on Windows while it is being copied.
			await rename(inboxPath, claimed);
		} catch (error) {
			logger.warn(
				`Skipping ${name}: could not claim it (${errorMessage(error)})`,
			);
			summary.skipped.push(name);
			continue;
		}
		try {
			await rename(logPathFor(inboxPath), logPathFor(claimed));
		} catch {
			// No log yet: first attempt.
		}
		try {
			const outcome = await processArchive(claimed, ctx);
			summary.results.push({ archive: name, outcome });
		} catch (error) {
			// Only file-system failures (writing the log, moving the archive) reach here.
			// The archive stays in processing/ and is recovered on the next run.
			logger.error(
				`Unexpected error while handling ${name}: ${errorMessage(error)}`,
			);
		}
	}
	return summary;
}

/** Archives still in processing/ were interrupted by a crash or shutdown; count that as a failed attempt. */
async function recoverInterrupted(ctx: JobContext): Promise<void> {
	const { paths, config, logger } = ctx;
	for (const name of await readdir(paths.processing)) {
		if (parseArchiveName(name) === null) continue;
		const archivePath = path.join(paths.processing, name);
		const log = await readLog(archivePath, name);
		const last = log.attempts.at(-1);
		if (last && last.finishedAt === undefined) {
			last.finishedAt = new Date().toISOString();
			last.outcome = "interrupted";
			last.error = "The app stopped while this attempt was running";
		}
		log.status =
			log.attemptsInRound >= config.maxAttempts ? "failed" : "retrying";
		await writeLog(archivePath, log);
		await moveArchive(
			archivePath,
			log.status === "failed" ? paths.failed : paths.inbox,
		);
		logger.warn(`Recovered interrupted ${name} → ${log.status}`);
	}
}

async function clearWorkDir(ctx: JobContext): Promise<void> {
	for (const entry of await readdir(ctx.paths.work)) {
		await rm(path.join(ctx.paths.work, entry), {
			recursive: true,
			force: true,
		});
	}
}

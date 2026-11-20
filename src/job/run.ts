import { readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parseArchiveName } from "../archive/formats.js";
import { errorMessage } from "../errors.js";
import { ensureDropDirs } from "../paths.js";
import { acquireDropLock } from "./lock.js";
import { moveArchive } from "./move.js";
import {
	type ArchiveOutcome,
	type JobContext,
	processArchive,
} from "./process-archive.js";
import { createReadinessCheck, PlatformNotReadyError } from "./readiness.js";
import { logPathFor, readLog, writeLog } from "./result-log.js";
import { scanInbox } from "./stability.js";

export interface RunSummary {
	/** False when another instance held the drop-folder lock and nothing was done. */
	ran: boolean;
	results: { archive: string; outcome: ArchiveOutcome }[];
	/** Archives left in inbox/ because they were still being copied or were locked. */
	skipped: string[];
	/** Set when a default platform wasn't ready, so the inbox was left untouched. */
	blocked?: string;
}

/**
 * One pass over the inbox, under an exclusive lock on the drop folder. Because
 * the lock guarantees no other instance is running, anything left in
 * processing/ or work/ is a crash leftover.
 */
export async function runOnce(ctx: JobContext): Promise<RunSummary> {
	const { paths, logger, config } = ctx;
	await ensureDropDirs(paths);
	const lock = await acquireDropLock(config.dropDir, ctx.lockOptions);
	if (!lock.acquired) {
		const by = lock.holder
			? ` (held by pid ${lock.holder.pid} on ${lock.holder.host} since ${lock.holder.acquiredAt})`
			: "";
		logger.warn(
			`Another instance is using the drop folder${by}; skipping this run`,
		);
		return { ran: false, results: [], skipped: [] };
	}
	if (lock.tookOverStale) {
		logger.warn("Took over a stale lock left by an instance that stopped");
	}
	try {
		return await processInbox(ctx);
	} finally {
		await lock.lock.release();
	}
}

async function processInbox(ctx: JobContext): Promise<RunSummary> {
	const { paths, logger } = ctx;
	await recoverInterrupted(ctx);
	await clearWorkDir(ctx);

	const scan = await scanInbox(paths.inbox, ctx.config.stabilityWaitMs);
	const summary: RunSummary = {
		ran: true,
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

	// Check the default platforms before claiming anything, so an expired
	// sign-in doesn't extract every archive just to put it back.
	const checkReady = createReadinessCheck(logger);
	for (const name of ctx.config.defaultPlatforms) {
		const platform = ctx.platforms.get(name);
		if (!platform) continue;
		try {
			await checkReady(platform);
		} catch (error) {
			if (!(error instanceof PlatformNotReadyError)) throw error;
			logger.error(
				`${error.message}. Leaving ${scan.ready.length} archive(s) in the inbox until this is fixed.`,
			);
			summary.skipped.push(...scan.ready.map((f) => path.basename(f)));
			summary.blocked = error.message;
			return summary;
		}
	}
	const runCtx = { ...ctx, checkReady };

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
			const outcome = await processArchive(claimed, runCtx);
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

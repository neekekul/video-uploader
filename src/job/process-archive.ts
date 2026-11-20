import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { extractArchive } from "../archive/extract.js";
import { parseArchiveName } from "../archive/formats.js";
import { inspectArchive } from "../archive/inspect.js";
import type { Config } from "../config.js";
import { buildDescription } from "../description.js";
import { errorMessage, ValidationError } from "../errors.js";
import type { Logger } from "../logger.js";
import { loadMetadata } from "../metadata/load.js";
import type { DropPaths } from "../paths.js";
import type { Platform, UploadJob } from "../platforms/types.js";
import { moveArchive } from "./move.js";
import {
	type AttemptRecord,
	type ResultLog,
	readLog,
	writeLog,
} from "./result-log.js";

export interface JobContext {
	config: Config;
	paths: DropPaths;
	platforms: Map<string, Platform>;
	logger: Logger;
}

export type ArchiveOutcome = "done" | "retrying" | "failed";

/**
 * Runs one archive that has already been claimed into processing/:
 * extract → inspect → validate → upload to each platform → write log → move to
 * done/, back to inbox/ (retry next run) or failed/. The extracted files are
 * always removed.
 */
export async function processArchive(
	archivePath: string,
	ctx: JobContext,
): Promise<ArchiveOutcome> {
	const { config, paths, logger } = ctx;
	const fileName = path.basename(archivePath);
	const parsed = parseArchiveName(fileName);
	if (!parsed) throw new Error(`Not a supported archive: ${fileName}`);

	const log = await readLog(archivePath, fileName);
	if (log.status === "done" || log.status === "failed") {
		// The archive was dropped back in by hand after finishing: start a fresh round of attempts.
		log.attemptsInRound = 0;
	}
	log.attemptsInRound += 1;
	log.status = "processing";
	const attempt: AttemptRecord = {
		attempt: log.attempts.length + 1,
		startedAt: new Date().toISOString(),
		warnings: [],
		platforms: {},
	};
	log.attempts.push(attempt);
	await writeLog(archivePath, log);
	logger.info(
		`Processing ${fileName} (attempt ${log.attemptsInRound} of ${config.maxAttempts})`,
	);

	const workDir = path.join(paths.work, randomUUID());
	let failure: unknown;
	try {
		await extractArchive(archivePath, parsed.format, workDir);
		const contents = await inspectArchive(workDir);
		attempt.warnings.push(...contents.warnings);

		const metadata = await loadMetadata(contents.metadataFile);
		const job: UploadJob = {
			archiveName: fileName,
			title: metadata.title ?? parsed.baseName.trim(),
			description: await buildDescription({
				configDir: config.configDir,
				descriptionFile: contents.descriptionFile,
				includeHeader: metadata.description?.includeHeader,
				includeFooter: metadata.description?.includeFooter,
			}),
			tags: metadata.tags ?? [],
			video: contents.video,
			captions: contents.captions,
			metadata,
		};
		if (contents.thumbnail) job.thumbnail = contents.thumbnail;
		attempt.title = job.title;

		const targets = resolvePlatforms(
			metadata.platforms ?? config.defaultPlatforms,
			ctx.platforms,
		);
		const problems = targets.flatMap((p) =>
			p.validate(job).map((msg) => `${p.name}: ${msg}`),
		);
		if (problems.length > 0) throw new ValidationError(problems);

		await uploadToPlatforms(job, targets, log, attempt, archivePath, logger);
	} catch (error) {
		failure = error;
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(
			(error: unknown) => {
				logger.warn(`Could not remove ${workDir}: ${errorMessage(error)}`);
			},
		);
	}

	attempt.finishedAt = new Date().toISOString();
	let outcome: ArchiveOutcome;
	let destDir: string;
	if (failure === undefined) {
		attempt.outcome = "success";
		outcome = "done";
		destDir = paths.done;
	} else {
		attempt.outcome = "failure";
		attempt.error = errorMessage(failure);
		const permanent = failure instanceof ValidationError;
		outcome =
			permanent || log.attemptsInRound >= config.maxAttempts
				? "failed"
				: "retrying";
		destDir = outcome === "failed" ? paths.failed : paths.inbox;
		logger.error(`${fileName}: ${attempt.error}`);
	}
	log.status = outcome;
	await writeLog(archivePath, log);
	const dest = await moveArchive(archivePath, destDir);
	logger.info(
		`${fileName} → ${outcome} (${path.relative(config.dropDir, dest)})`,
	);
	return outcome;
}

function resolvePlatforms(
	names: string[],
	available: Map<string, Platform>,
): Platform[] {
	const unknown = names.filter((n) => !available.has(n));
	if (unknown.length > 0) {
		throw new ValidationError([
			`Unknown platform(s): ${unknown.join(", ")}. Available: ${[...available.keys()].join(", ")}`,
		]);
	}
	return [...new Set(names)].map((n) => available.get(n) as Platform);
}

async function uploadToPlatforms(
	job: UploadJob,
	targets: Platform[],
	log: ResultLog,
	attempt: AttemptRecord,
	archivePath: string,
	logger: Logger,
): Promise<void> {
	const failures: string[] = [];
	for (const platform of targets) {
		const previous = log.uploaded[platform.name];
		if (previous) {
			attempt.platforms[platform.name] = {
				status: "skipped",
				reason: `already uploaded in attempt ${previous.attempt} (id ${previous.id})`,
			};
			continue;
		}
		try {
			const result = await platform.upload(job, logger);
			const uploadedAt = new Date().toISOString();
			log.uploaded[platform.name] = {
				id: result.id,
				...(result.url === undefined ? {} : { url: result.url }),
				attempt: attempt.attempt,
				uploadedAt,
			};
			attempt.platforms[platform.name] = {
				status: "success",
				id: result.id,
				...(result.url === undefined ? {} : { url: result.url }),
			};
			attempt.warnings.push(
				...(result.warnings ?? []).map((w) => `${platform.name}: ${w}`),
			);
			// Persist right away so a crash after this point can't cause a duplicate upload.
			await writeLog(archivePath, log);
		} catch (error) {
			const message = errorMessage(error);
			attempt.platforms[platform.name] = { status: "failure", error: message };
			failures.push(`${platform.name}: ${message}`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`Upload failed for ${failures.join("; ")}`);
	}
}

import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { releaseHeldLocksSync } from "./job/lock.js";
import type { JobContext } from "./job/process-archive.js";
import { runOnce } from "./job/run.js";
import { consoleLogger } from "./logger.js";
import { dropPaths } from "./paths.js";
import { createPlatforms } from "./platforms/registry.js";
import { runYoutubeAuthFlow } from "./platforms/youtube/auth-flow.js";
import { startScheduler } from "./scheduler.js";

const USAGE = `Usage: video-uploader <command>

Commands:
  start      Run on the configured schedule (default)
  run-once   Process the inbox once and exit
  auth youtube
             Sign in to YouTube once and save the refresh token`;

/** Loads ./.env if present. Variables already set in the environment win. */
function loadEnvFile(): void {
	try {
		process.loadEnvFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function main(command: string, args: string[]): Promise<void> {
	loadEnvFile();
	const config = loadConfig();
	const ctx: JobContext = {
		config,
		paths: dropPaths(config.dropDir),
		platforms: createPlatforms(config),
		logger: consoleLogger,
	};

	// An archive mid-upload stays in processing/ and is recovered next run;
	// the lock must go now so that run isn't skipped.
	const shutdown = () => {
		consoleLogger.info("Shutting down");
		releaseHeldLocksSync();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	switch (command) {
		case "start":
			startScheduler(ctx);
			return;
		case "run-once": {
			const summary = await runOnce(ctx);
			for (const { archive, outcome } of summary.results) {
				consoleLogger.info(`${archive}: ${outcome}`);
			}
			return;
		}
		case "auth":
			if (args[0] === "youtube") {
				await runYoutubeAuthFlow(config.youtube, consoleLogger);
				return;
			}
			console.error(USAGE);
			process.exitCode = 1;
			return;
		default:
			console.error(USAGE);
			process.exitCode = 1;
	}
}

main(process.argv[2] ?? "start", process.argv.slice(3)).catch(
	(error: unknown) => {
		consoleLogger.error(errorMessage(error));
		process.exitCode = 1;
	},
);

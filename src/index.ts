import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import type { JobContext } from "./job/process-archive.js";
import { runOnce } from "./job/run.js";
import { consoleLogger } from "./logger.js";
import { dropPaths } from "./paths.js";
import { createPlatforms } from "./platforms/registry.js";
import { startScheduler } from "./scheduler.js";

const USAGE = `Usage: video-uploader <command>

Commands:
  start      Run on the configured schedule (default)
  run-once   Process the inbox once and exit`;

/** Loads ./.env if present. Variables already set in the environment win. */
function loadEnvFile(): void {
	try {
		process.loadEnvFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function main(command: string): Promise<void> {
	loadEnvFile();
	const config = loadConfig();
	const ctx: JobContext = {
		config,
		paths: dropPaths(config.dropDir),
		platforms: createPlatforms(),
		logger: consoleLogger,
	};

	switch (command) {
		case "start": {
			const job = startScheduler(ctx);
			const stop = () => {
				consoleLogger.info("Shutting down");
				job.stop();
				process.exit(0);
			};
			process.on("SIGINT", stop);
			process.on("SIGTERM", stop);
			return;
		}
		case "run-once": {
			const summary = await runOnce(ctx);
			for (const { archive, outcome } of summary.results) {
				consoleLogger.info(`${archive}: ${outcome}`);
			}
			return;
		}
		default:
			console.error(USAGE);
			process.exitCode = 1;
	}
}

main(process.argv[2] ?? "start").catch((error: unknown) => {
	consoleLogger.error(errorMessage(error));
	process.exitCode = 1;
});

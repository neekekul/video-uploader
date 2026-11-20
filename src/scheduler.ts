import { Cron } from "croner";
import { errorMessage } from "./errors.js";
import type { JobContext } from "./job/process-archive.js";
import { runOnce } from "./job/run.js";

/**
 * Runs the inbox on the configured cron schedule. A run that is due while the
 * previous one is still uploading is skipped rather than overlapped.
 */
export function startScheduler(ctx: JobContext): Cron {
	const { logger, config } = ctx;
	const job = new Cron(
		config.schedule,
		{
			protect: () =>
				logger.warn("Previous run still in progress; skipping this one"),
			catch: (error) => logger.error(`Run failed: ${errorMessage(error)}`),
		},
		async () => {
			logger.info("Run started");
			const summary = await runOnce(ctx);
			logger.info(
				`Run finished: ${summary.results.length} processed, ${summary.skipped.length} skipped`,
			);
		},
	);
	if (config.runOnStart) job.trigger();
	logger.info(
		`Scheduled with "${config.schedule}"; next run ${job.nextRun()?.toISOString() ?? "never"}`,
	);
	return job;
}

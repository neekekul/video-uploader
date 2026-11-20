import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Platform } from "./types.js";

/** Logs what would be uploaded without contacting any service. */
export const dryRunPlatform: Platform = {
	name: "dry-run",

	validate: () => [],

	async upload(job, logger) {
		const { size } = await stat(job.video);
		logger.info(
			[
				`[dry-run] Would upload "${job.title}" (${(size / 1024 / 1024).toFixed(1)} MiB)`,
				`  tags: ${job.tags.join(", ") || "(none)"}`,
				`  thumbnail: ${job.thumbnail ?? "(none)"}`,
				`  captions: ${job.captions.map((c) => c.language).join(", ") || "(none)"}`,
				`  description:\n${job.description.replace(/^/gm, "    ")}`,
			].join("\n"),
		);
		const id = createHash("sha256")
			.update(job.archiveName)
			.digest("hex")
			.slice(0, 12);
		return { id: `dry-run-${id}` };
	},
};

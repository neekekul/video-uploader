import { z } from "zod";
import { youtubeOptionsSchema } from "../platforms/youtube/options.js";

/**
 * Schema for metadata.yaml / metadata.yml / metadata.json. Shared fields live at
 * the top level; each platform gets its own section. Unknown keys are rejected
 * so typos fail the job instead of being silently ignored.
 */
export const metadataSchema = z.strictObject({
	/** Defaults to the archive name. */
	title: z.string().trim().min(1).optional(),
	tags: z.array(z.string().trim().min(1)).optional(),
	/** Overrides the PLATFORMS setting for this archive. */
	platforms: z.array(z.string().min(1)).min(1).optional(),
	description: z
		.strictObject({
			includeHeader: z.boolean().optional(),
			includeFooter: z.boolean().optional(),
		})
		.optional(),
	youtube: youtubeOptionsSchema.optional(),
});

export type Metadata = z.infer<typeof metadataSchema>;

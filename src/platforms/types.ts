import type { CaptionFile } from "../archive/inspect.js";
import type { Logger } from "../logger.js";
import type { Metadata } from "../metadata/schema.js";

/** Everything a platform needs to publish one video, platform-agnostic. */
export interface UploadJob {
	archiveName: string;
	title: string;
	description: string;
	tags: string[];
	video: string;
	thumbnail?: string;
	captions: CaptionFile[];
	/** Full metadata, so platforms can read their own section (e.g. `metadata.youtube`). */
	metadata: Metadata;
}

export interface UploadResult {
	/** Platform-specific ID of the published video. */
	id: string;
	url?: string;
	/** Non-fatal problems, e.g. the video uploaded but the thumbnail was rejected. */
	warnings?: string[];
}

export interface Platform {
	readonly name: string;
	/**
	 * Checks the job against platform limits before anything is uploaded.
	 * Returns a list of problems; empty means valid.
	 */
	validate(job: UploadJob): string[] | Promise<string[]>;
	upload(job: UploadJob, logger: Logger): Promise<UploadResult>;
	/**
	 * Optional cheap check that the platform is usable right now, such as
	 * credentials present and not expired. Throw with a readable message if not.
	 * Archives are left untouched, without using an attempt, until it passes.
	 */
	preflight?(logger: Logger): Promise<void>;
}

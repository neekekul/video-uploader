import type { Config } from "../config.js";
import { dryRunPlatform } from "./dry-run.js";
import type { Platform } from "./types.js";
import { createRealYoutubePlatform } from "./youtube/platform.js";

/** All platforms the app knows about, keyed by the name used in config and metadata. */
export function createPlatforms(config: Config): Map<string, Platform> {
	const platforms = [dryRunPlatform, createRealYoutubePlatform(config.youtube)];
	return new Map(platforms.map((p) => [p.name, p]));
}

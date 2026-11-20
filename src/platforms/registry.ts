import { dryRunPlatform } from "./dry-run.js";
import type { Platform } from "./types.js";

/** All platforms the app knows about, keyed by the name used in config and metadata. */
export function createPlatforms(): Map<string, Platform> {
	return new Map([[dryRunPlatform.name, dryRunPlatform]]);
}

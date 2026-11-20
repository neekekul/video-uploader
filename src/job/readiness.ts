import { errorMessage } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Platform } from "../platforms/types.js";

/**
 * A platform can't be used right now (missing credentials, expired sign-in).
 * That's a setup problem, not a problem with the archive, so it must not use
 * up the archive's attempts.
 */
export class PlatformNotReadyError extends Error {
	readonly platform: string;

	constructor(platform: string, reason: string) {
		super(`${platform} is not ready: ${reason}`);
		this.name = "PlatformNotReadyError";
		this.platform = platform;
	}
}

export type ReadinessCheck = (platform: Platform) => Promise<void>;

/**
 * Runs each platform's `preflight()` at most once and remembers the result,
 * so one run checks credentials once no matter how many archives it handles.
 */
export function createReadinessCheck(logger: Logger): ReadinessCheck {
	const results = new Map<string, Promise<void>>();
	return async (platform) => {
		if (!platform.preflight) return;
		let result = results.get(platform.name);
		if (!result) {
			result = platform.preflight(logger);
			results.set(platform.name, result);
		}
		try {
			await result;
		} catch (error) {
			throw new PlatformNotReadyError(platform.name, errorMessage(error));
		}
	};
}

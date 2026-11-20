import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
	DROP_DIR: z.string().min(1).default("./drop"),
	CONFIG_DIR: z.string().min(1).default("./config"),
	SCHEDULE: z.string().min(1).default("0 */2 * * *"),
	RUN_ON_START: z.enum(["true", "false"]).default("true"),
	STABILITY_WAIT_SECONDS: z.coerce.number().min(0).default(10),
	MAX_ATTEMPTS: z.coerce.number().int().min(1).default(2),
	PLATFORMS: z.string().min(1).default("youtube"),
	YOUTUBE_CLIENT_SECRET_FILE: z
		.string()
		.min(1)
		.default("./credentials/youtube-client-secret.json"),
	YOUTUBE_TOKEN_FILE: z
		.string()
		.min(1)
		.default("./credentials/youtube-token.json"),
});

export interface Config {
	/** Root of inbox/processing/done/failed/work. */
	dropDir: string;
	/** Holds description-header.txt and description-footer.txt. */
	configDir: string;
	/** Cron expression for scheduled runs. */
	schedule: string;
	runOnStart: boolean;
	/** How long an inbox file must keep the same size/mtime before it is picked up. */
	stabilityWaitMs: number;
	/** Attempts per archive before it is moved to failed/ (1 initial + retries). */
	maxAttempts: number;
	/** Platforms used when an archive's metadata does not list any. */
	defaultPlatforms: string[];
	youtube: {
		/** OAuth "Desktop app" client JSON downloaded from Google Cloud Console. */
		clientSecretFile: string;
		/** Refresh token written by `auth youtube`. */
		tokenFile: string;
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const parsed = envSchema.safeParse(env);
	if (!parsed.success) {
		throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
	}
	const e = parsed.data;
	return {
		dropDir: path.resolve(e.DROP_DIR),
		configDir: path.resolve(e.CONFIG_DIR),
		schedule: e.SCHEDULE,
		runOnStart: e.RUN_ON_START === "true",
		stabilityWaitMs: e.STABILITY_WAIT_SECONDS * 1000,
		maxAttempts: e.MAX_ATTEMPTS,
		defaultPlatforms: e.PLATFORMS.split(",")
			.map((p) => p.trim())
			.filter(Boolean),
		youtube: {
			clientSecretFile: path.resolve(e.YOUTUBE_CLIENT_SECRET_FILE),
			tokenFile: path.resolve(e.YOUTUBE_TOKEN_FILE),
		},
	};
}

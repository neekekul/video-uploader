import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { auth } from "@googleapis/youtube";
import type { Credentials, OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { errorMessage } from "../../errors.js";
import type { Logger } from "../../logger.js";

/**
 * youtube.upload covers videos.insert and thumbnails.set; youtube.force-ssl
 * covers captions and playlist items.
 */
export const YOUTUBE_SCOPES = [
	"https://www.googleapis.com/auth/youtube.upload",
	"https://www.googleapis.com/auth/youtube.force-ssl",
];

export const AUTH_COMMAND = "npm run auth:youtube";

export interface YoutubeCredentialPaths {
	clientSecretFile: string;
	tokenFile: string;
}

export interface ClientSecret {
	clientId: string;
	clientSecret: string;
}

const clientSecretSchema = z.object({
	installed: z.object({
		client_id: z.string().min(1),
		client_secret: z.string().min(1),
	}),
});

/** Reads the OAuth client JSON downloaded from Google Cloud Console ("Desktop app" type). */
export async function loadClientSecret(file: string): Promise<ClientSecret> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		throw new Error(
			`Could not read the YouTube OAuth client file at ${file} (${errorMessage(error)}). ` +
				"Download it from Google Cloud Console → APIs & Services → Credentials " +
				"(OAuth client ID, type Desktop app) and save it there, or set YOUTUBE_CLIENT_SECRET_FILE.",
		);
	}
	const parsed = clientSecretSchema.safeParse(JSON.parse(raw));
	if (!parsed.success) {
		throw new Error(
			`${file} is not a Desktop app OAuth client file (expected an "installed" section). ` +
				'Create the OAuth client with application type "Desktop app".',
		);
	}
	return {
		clientId: parsed.data.installed.client_id,
		clientSecret: parsed.data.installed.client_secret,
	};
}

export async function readToken(file: string): Promise<Credentials> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		throw new Error(
			`YouTube is not authorized yet (no token at ${file}). Run \`${AUTH_COMMAND}\` once.`,
		);
	}
	const token = JSON.parse(raw) as Credentials;
	if (!token.refresh_token) {
		throw new Error(
			`${file} has no refresh token. Run \`${AUTH_COMMAND}\` again.`,
		);
	}
	return token;
}

export async function writeToken(
	file: string,
	token: Credentials,
): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(token, null, "\t")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

export function createOAuthClient(
	secret: ClientSecret,
	redirectUri?: string,
): OAuth2Client {
	return new auth.OAuth2({
		clientId: secret.clientId,
		clientSecret: secret.clientSecret,
		...(redirectUri === undefined ? {} : { redirectUri }),
	});
}

/**
 * Builds an OAuth client from the saved refresh token. Access tokens are
 * refreshed automatically; any new tokens Google hands back are saved so a
 * rotated refresh token is never lost.
 */
export async function loadAuthorizedClient(
	paths: YoutubeCredentialPaths,
	logger: Logger,
): Promise<OAuth2Client> {
	const secret = await loadClientSecret(paths.clientSecretFile);
	let token = await readToken(paths.tokenFile);
	const client = createOAuthClient(secret);
	client.setCredentials(token);
	client.on("tokens", (fresh) => {
		token = { ...token, ...fresh };
		writeToken(paths.tokenFile, token).catch((error: unknown) => {
			logger.warn(
				`Could not save refreshed YouTube token: ${errorMessage(error)}`,
			);
		});
	});
	return client;
}

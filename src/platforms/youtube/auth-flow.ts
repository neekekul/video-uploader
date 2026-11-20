import { randomBytes } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { youtube } from "@googleapis/youtube";
import { CodeChallengeMethod } from "google-auth-library";
import type { Logger } from "../../logger.js";
import {
	createOAuthClient,
	loadClientSecret,
	writeToken,
	YOUTUBE_SCOPES,
	type YoutubeCredentialPaths,
} from "./credentials.js";

const TIMEOUT_MS = 5 * 60_000;

/**
 * One-time interactive login (OAuth "Desktop app" loopback flow with PKCE).
 * Prints a URL, waits for Google to redirect back to a temporary local
 * server, then saves the refresh token used by every later upload.
 */
export async function runYoutubeAuthFlow(
	paths: YoutubeCredentialPaths,
	logger: Logger,
): Promise<void> {
	const secret = await loadClientSecret(paths.clientSecretFile);

	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const { port } = server.address() as AddressInfo;
		const client = createOAuthClient(secret, `http://127.0.0.1:${port}`);
		const { codeVerifier, codeChallenge } =
			await client.generateCodeVerifierAsync();
		const state = randomBytes(16).toString("hex");
		const url = client.generateAuthUrl({
			access_type: "offline",
			// Forces Google to issue a refresh token even if this app was authorized before.
			prompt: "consent",
			scope: YOUTUBE_SCOPES,
			state,
			code_challenge_method: CodeChallengeMethod.S256,
			...(codeChallenge === undefined ? {} : { code_challenge: codeChallenge }),
		});

		logger.info(
			`Open this URL in a browser and sign in with the account that owns your channel:\n\n${url}\n`,
		);
		const code = await waitForAuthCode(server, state, TIMEOUT_MS);
		const { tokens } = await client.getToken({ code, codeVerifier });
		if (!tokens.refresh_token) {
			throw new Error(
				"Google did not return a refresh token. Remove this app's access at " +
					"https://myaccount.google.com/permissions and run the command again.",
			);
		}
		await writeToken(paths.tokenFile, tokens);
		logger.info(`Saved YouTube token to ${paths.tokenFile}`);

		client.setCredentials(tokens);
		const channels = await youtube({
			version: "v3",
			auth: client,
		}).channels.list({
			part: ["snippet"],
			mine: true,
		});
		const channel = channels.data.items?.[0]?.snippet?.title;
		logger.info(
			channel
				? `Authorized for channel "${channel}"`
				: "Authorized, but this account has no YouTube channel yet",
		);
	} finally {
		server.close();
	}
}

/**
 * Resolves with the authorization code from the first request carrying the
 * expected `state`. Other requests (favicon, stray hits) are answered and ignored.
 */
export function waitForAuthCode(
	server: Server,
	state: string,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			server.off("request", onRequest);
			reject(new Error("Timed out waiting for the Google sign-in to finish"));
		}, timeoutMs);

		function finish(error: Error | null, code?: string) {
			clearTimeout(timer);
			server.off("request", onRequest);
			if (error) reject(error);
			else resolve(code as string);
		}

		function onRequest(req: IncomingMessage, res: ServerResponse) {
			const params = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
			const reply = (status: number, message: string) => {
				res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
				res.end(message);
			};
			if (params.get("state") !== state) {
				reply(400, "Unexpected request.");
				return;
			}
			const error = params.get("error");
			if (error) {
				reply(400, `Sign-in failed: ${error}. You can close this tab.`);
				finish(new Error(`Google sign-in failed: ${error}`));
				return;
			}
			const code = params.get("code");
			if (!code) {
				reply(400, "Missing authorization code.");
				return;
			}
			reply(200, "video-uploader is authorized. You can close this tab.");
			finish(null, code);
		}

		server.on("request", onRequest);
	});
}

import { errorMessage } from "../../errors.js";
import { AUTH_COMMAND } from "./credentials.js";

interface GoogleErrorShape {
	status?: number;
	response?: {
		status?: number;
		data?: {
			error?: string | { message?: string; errors?: { reason?: string }[] };
			error_description?: string;
		};
	};
}

/** Hints prepended to Google's own message for well-known error reasons. */
const REASONS: Record<string, string> = {
	quotaExceeded:
		"YouTube API daily quota is used up (it resets at midnight Pacific time)",
	dailyLimitExceeded:
		"YouTube API daily quota is used up (it resets at midnight Pacific time)",
	uploadLimitExceeded: "This channel has hit YouTube's upload limit for now",
	youtubeSignupRequired: "The authorized Google account has no YouTube channel",
};

/**
 * Turns a googleapis/gaxios error into one readable line for the result log:
 * an optional hint, then Google's own message, then status and reason.
 * `hints` adds call-specific explanations (e.g. what "forbidden" means for thumbnails).
 */
export function describeYoutubeError(
	error: unknown,
	hints: Record<string, string> = {},
): string {
	const e = error as GoogleErrorShape;
	const data = e?.response?.data;
	const status = e?.response?.status ?? e?.status;

	// OAuth token endpoint errors, e.g. a revoked or expired refresh token.
	if (data?.error === "invalid_grant") {
		return (
			"YouTube authorization has expired or was revoked. " +
			`Run \`${AUTH_COMMAND}\` again. If this keeps happening every 7 days, ` +
			'publish the OAuth consent screen ("In production") in Google Cloud Console.'
		);
	}

	const apiError = typeof data?.error === "object" ? data.error : undefined;
	const reason = apiError?.errors?.[0]?.reason;
	const hint = reason ? (hints[reason] ?? REASONS[reason]) : undefined;
	const message = apiError?.message ?? errorMessage(error);
	const code = [status, reason].filter(Boolean).join(" ");
	return [
		hint ? `${hint}.` : undefined,
		message,
		code ? `[${code}]` : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

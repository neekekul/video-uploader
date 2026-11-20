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

const REASONS: Record<string, string> = {
	quotaExceeded:
		"YouTube API daily quota is used up (it resets at midnight Pacific time)",
	dailyLimitExceeded:
		"YouTube API daily quota is used up (it resets at midnight Pacific time)",
	uploadLimitExceeded: "This channel has hit YouTube's upload limit for now",
	youtubeSignupRequired: "The authorized Google account has no YouTube channel",
	forbidden: "YouTube refused the request (check the channel's permissions)",
};

/** Turns a googleapis/gaxios error into one readable line for the result log. */
export function describeYoutubeError(error: unknown): string {
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
	const known = reason ? REASONS[reason] : undefined;
	if (known) return `${known} [${reason}]`;

	const message = apiError?.message ?? errorMessage(error);
	const prefix = [status, reason].filter(Boolean).join(" ");
	return prefix ? `${prefix}: ${message}` : message;
}

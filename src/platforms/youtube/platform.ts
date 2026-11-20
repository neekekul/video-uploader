import path from "node:path";
import type { Logger } from "../../logger.js";
import type { Platform, UploadJob } from "../types.js";
import { createYoutubeApi, type YoutubeApi } from "./api.js";
import {
	loadAuthorizedClient,
	type YoutubeCredentialPaths,
} from "./credentials.js";
import { describeYoutubeError } from "./errors.js";
import { buildInsertParams, validateForYoutube } from "./resource.js";

const THUMBNAIL_FORBIDDEN_HINT =
	"Custom thumbnails need a verified channel: verify with a phone number at " +
	"https://www.youtube.com/verify, then set this video's thumbnail in YouTube Studio";

export type YoutubeApiFactory = (logger: Logger) => Promise<YoutubeApi>;

export function createYoutubePlatform(getApi: YoutubeApiFactory): Platform {
	return {
		name: "youtube",
		validate: validateForYoutube,
		upload: (job, logger) => uploadToYoutube(job, logger, getApi),
	};
}

/** The real platform: credentials are only read when something is uploaded. */
export function createRealYoutubePlatform(
	paths: YoutubeCredentialPaths,
): Platform {
	return createYoutubePlatform(async (logger) =>
		createYoutubeApi(await loadAuthorizedClient(paths, logger)),
	);
}

async function uploadToYoutube(
	job: UploadJob,
	logger: Logger,
	getApi: YoutubeApiFactory,
) {
	const api = await getApi(logger);
	const params = buildInsertParams(job);

	logger.info(`[youtube] Uploading "${job.title}"`);
	let video: Awaited<ReturnType<YoutubeApi["insertVideo"]>>;
	try {
		video = await api.insertVideo(params, job.video);
	} catch (error) {
		throw new Error(describeYoutubeError(error));
	}
	const id = video.id;
	if (!id)
		throw new Error("YouTube accepted the upload but returned no video ID");
	logger.info(`[youtube] Uploaded as ${id}`);

	// The video exists from here on. Later steps must not throw, or a retry
	// would upload it a second time, so their failures become warnings.
	const warnings: string[] = [];
	const step = async (
		label: string,
		run: () => Promise<void>,
		hints?: Record<string, string>,
	) => {
		try {
			await run();
		} catch (error) {
			const message = `${label} failed: ${describeYoutubeError(error, hints)}`;
			logger.warn(`[youtube] ${message}`);
			warnings.push(message);
		}
	};

	const requested = params.requestBody?.status?.privacyStatus;
	const actual = video.status?.privacyStatus;
	if (requested && actual && requested !== actual) {
		warnings.push(
			`requested privacy "${requested}" but YouTube set "${actual}". ` +
				"Videos uploaded by unaudited API projects are locked to private.",
		);
	}

	if (job.thumbnail) {
		const thumbnail = job.thumbnail;
		const mimeType =
			path.extname(thumbnail).toLowerCase() === ".png"
				? "image/png"
				: "image/jpeg";
		await step("thumbnail", () => api.setThumbnail(id, thumbnail, mimeType), {
			forbidden: THUMBNAIL_FORBIDDEN_HINT,
		});
	}
	for (const caption of job.captions) {
		await step(`${caption.language} captions`, () =>
			api.insertCaption(id, caption.language, caption.path),
		);
	}
	for (const playlistId of job.metadata.youtube?.playlists ?? []) {
		await step(`adding to playlist ${playlistId}`, () =>
			api.addToPlaylist(playlistId, id),
		);
	}

	return { id, url: `https://youtu.be/${id}`, warnings };
}

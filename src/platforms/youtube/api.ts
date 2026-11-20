import { createReadStream } from "node:fs";
import { youtube, type youtube_v3 } from "@googleapis/youtube";
import type { OAuth2Client } from "google-auth-library";

/**
 * The few YouTube Data API calls the uploader makes. Kept narrow so the
 * platform can be tested against a fake.
 *
 * Quota cost per call (default quota is 10,000 units/day): insertVideo 1600,
 * setThumbnail 50, insertCaption 400, addToPlaylist 50.
 */
export interface YoutubeApi {
	insertVideo(
		params: Omit<youtube_v3.Params$Resource$Videos$Insert, "media">,
		videoFile: string,
	): Promise<youtube_v3.Schema$Video>;
	setThumbnail(videoId: string, file: string, mimeType: string): Promise<void>;
	insertCaption(videoId: string, language: string, file: string): Promise<void>;
	addToPlaylist(playlistId: string, videoId: string): Promise<void>;
}

export function createYoutubeApi(auth: OAuth2Client): YoutubeApi {
	const client = youtube({ version: "v3", auth });
	return {
		async insertVideo(params, videoFile) {
			const res = await client.videos.insert({
				...params,
				media: { mimeType: "video/mp4", body: createReadStream(videoFile) },
			});
			return res.data;
		},
		async setThumbnail(videoId, file, mimeType) {
			await client.thumbnails.set({
				videoId,
				media: { mimeType, body: createReadStream(file) },
			});
		},
		async insertCaption(videoId, language, file) {
			await client.captions.insert({
				part: ["snippet"],
				requestBody: { snippet: { videoId, language, name: "" } },
				media: {
					mimeType: "application/octet-stream",
					body: createReadStream(file),
				},
			});
		},
		async addToPlaylist(playlistId, videoId) {
			await client.playlistItems.insert({
				part: ["snippet"],
				requestBody: {
					snippet: {
						playlistId,
						resourceId: { kind: "youtube#video", videoId },
					},
				},
			});
		},
	};
}

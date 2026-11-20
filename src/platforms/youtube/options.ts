import { z } from "zod";

const dateTime = z.iso.datetime({ offset: true });

/** The `youtube:` section of metadata.yaml. Every field is optional. */
export const youtubeOptionsSchema = z
	.strictObject({
		privacy: z.enum(["public", "unlisted", "private"]).optional(),
		/** Scheduled publish time. YouTube requires the video to be private until then. */
		publishAt: dateTime.optional(),
		/** e.g. 20 = Gaming, 22 = People & Blogs, 24 = Entertainment. */
		categoryId: z
			.union([z.string().regex(/^\d+$/), z.number().int().positive()])
			.transform(String)
			.optional(),
		madeForKids: z.boolean().optional(),
		/** Disclosure for realistic AI-generated or altered content. */
		containsSyntheticMedia: z.boolean().optional(),
		notifySubscribers: z.boolean().optional(),
		embeddable: z.boolean().optional(),
		publicStatsViewable: z.boolean().optional(),
		license: z.enum(["youtube", "creativeCommon"]).optional(),
		defaultLanguage: z.string().min(2).optional(),
		defaultAudioLanguage: z.string().min(2).optional(),
		recordingDate: z.union([z.iso.date(), dateTime]).optional(),
		/** Playlist IDs the video is added to after upload. */
		playlists: z.array(z.string().min(1)).optional(),
		/** Translated title/description keyed by language, e.g. `es`. */
		localizations: z
			.record(
				z.string().min(2),
				z.strictObject({
					title: z.string().min(1).optional(),
					description: z.string().optional(),
				}),
			)
			.optional(),
	})
	.refine(
		(o) =>
			o.publishAt === undefined ||
			o.privacy === undefined ||
			o.privacy === "private",
		{
			message: "publishAt requires privacy to be private (or left unset)",
			path: ["publishAt"],
		},
	);

export type YoutubeOptions = z.infer<typeof youtubeOptionsSchema>;

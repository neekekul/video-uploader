import { stat } from "node:fs/promises";
import type { youtube_v3 } from "@googleapis/youtube";
import type { UploadJob } from "../types.js";
import type { YoutubeOptions } from "./options.js";

export const DEFAULT_PRIVACY = "private";
/** People & Blogs. YouTube needs some category; this is its own default. */
export const DEFAULT_CATEGORY_ID = "22";

const MAX_TITLE_CHARS = 100;
const MAX_DESCRIPTION_BYTES = 5000;
const MAX_TAGS_CHARS = 500;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

function options(job: UploadJob): YoutubeOptions {
	return job.metadata.youtube ?? {};
}

/**
 * YouTube counts the tags field as it would appear joined with commas, with
 * tags that contain spaces wrapped in quotes.
 */
export function tagsLength(tags: string[]): number {
	const chars = tags.reduce(
		(sum, tag) => sum + tag.length + (tag.includes(" ") ? 2 : 0),
		0,
	);
	return chars + Math.max(tags.length - 1, 0);
}

function checkText(
	problems: string[],
	label: string,
	text: string,
	limit: { chars?: number; bytes?: number },
): void {
	if (/[<>]/.test(text)) problems.push(`${label} must not contain < or >`);
	if (limit.chars !== undefined && [...text].length > limit.chars) {
		problems.push(
			`${label} is ${[...text].length} characters; the limit is ${limit.chars}`,
		);
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (limit.bytes !== undefined && bytes > limit.bytes) {
		problems.push(
			`${label} is ${bytes} bytes; the limit is ${limit.bytes} (header and footer included)`,
		);
	}
}

/** Checks the job against YouTube's limits so problems are caught before uploading. */
export async function validateForYoutube(job: UploadJob): Promise<string[]> {
	const problems: string[] = [];
	const o = options(job);

	checkText(problems, "title", job.title, { chars: MAX_TITLE_CHARS });
	checkText(problems, "description", job.description, {
		bytes: MAX_DESCRIPTION_BYTES,
	});
	if (tagsLength(job.tags) > MAX_TAGS_CHARS) {
		problems.push(
			`tags total ${tagsLength(job.tags)} characters; the limit is ${MAX_TAGS_CHARS}`,
		);
	}
	for (const [lang, loc] of Object.entries(o.localizations ?? {})) {
		if (loc.title !== undefined) {
			checkText(problems, `localizations.${lang}.title`, loc.title, {
				chars: MAX_TITLE_CHARS,
			});
		}
		if (loc.description !== undefined) {
			checkText(
				problems,
				`localizations.${lang}.description`,
				loc.description,
				{ bytes: MAX_DESCRIPTION_BYTES },
			);
		}
	}
	if (o.localizations && !o.defaultLanguage) {
		problems.push("localizations require youtube.defaultLanguage to be set");
	}
	if (o.publishAt && Date.parse(o.publishAt) <= Date.now()) {
		problems.push(`publishAt ${o.publishAt} is in the past`);
	}
	if (job.thumbnail) {
		const { size } = await stat(job.thumbnail);
		if (size > MAX_THUMBNAIL_BYTES) {
			problems.push(
				`thumbnail is ${(size / 1024 / 1024).toFixed(1)} MiB; the limit is 2 MiB`,
			);
		}
	}
	return problems;
}

/** Drops undefined values so optional settings are left to YouTube's defaults. */
function defined<T extends object>(
	obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined),
	) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** Builds the videos.insert request (everything except the media body). */
export function buildInsertParams(
	job: UploadJob,
): Omit<youtube_v3.Params$Resource$Videos$Insert, "media"> {
	const o = options(job);
	const part = ["snippet", "status"];

	const requestBody: youtube_v3.Schema$Video = {
		snippet: defined({
			title: job.title,
			description: job.description,
			tags: job.tags.length > 0 ? job.tags : undefined,
			categoryId: o.categoryId ?? DEFAULT_CATEGORY_ID,
			defaultLanguage: o.defaultLanguage,
			defaultAudioLanguage: o.defaultAudioLanguage,
		}),
		status: defined({
			// A scheduled video must stay private until publishAt.
			privacyStatus: o.publishAt ? "private" : (o.privacy ?? DEFAULT_PRIVACY),
			publishAt: o.publishAt,
			license: o.license,
			embeddable: o.embeddable,
			publicStatsViewable: o.publicStatsViewable,
			selfDeclaredMadeForKids: o.madeForKids,
			containsSyntheticMedia: o.containsSyntheticMedia,
		}),
	};

	if (o.recordingDate) {
		part.push("recordingDetails");
		requestBody.recordingDetails = {
			// The API wants a full timestamp; a bare date means midnight UTC.
			recordingDate: o.recordingDate.includes("T")
				? o.recordingDate
				: `${o.recordingDate}T00:00:00Z`,
		};
	}
	if (o.localizations) {
		part.push("localizations");
		requestBody.localizations = Object.fromEntries(
			Object.entries(o.localizations).map(([lang, loc]) => [
				lang,
				defined({
					title: loc.title ?? job.title,
					description: loc.description ?? job.description,
				}),
			]),
		);
	}

	return {
		part,
		requestBody,
		...(o.notifySubscribers === undefined
			? {}
			: { notifySubscribers: o.notifySubscribers }),
	};
}

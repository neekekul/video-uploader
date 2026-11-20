import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildDescription,
	FOOTER_FILE,
	HEADER_FILE,
} from "../src/description.js";
import { ValidationError } from "../src/errors.js";
import { loadMetadata } from "../src/metadata/load.js";
import { tempDir, writeFiles } from "./helpers.js";

async function load(name: string, content: string) {
	const dir = await tempDir();
	await writeFiles(dir, { [name]: content });
	return loadMetadata(path.join(dir, name));
}

describe("loadMetadata", () => {
	it("returns empty metadata when there is no file or it is empty", async () => {
		expect(await loadMetadata(undefined)).toEqual({});
		expect(await load("metadata.yaml", "# only a comment\n")).toEqual({});
	});

	it("parses a full YAML file", async () => {
		const metadata = await load(
			"metadata.yaml",
			`
title: "  My Title  "
tags: [gaming, speedrun]
platforms: [youtube]
description:
  includeHeader: false
youtube:
  privacy: private
  publishAt: 2026-12-01T17:00:00Z
  categoryId: 20
  madeForKids: false
  containsSyntheticMedia: false
  notifySubscribers: true
  embeddable: true
  publicStatsViewable: false
  license: creativeCommon
  defaultLanguage: en
  defaultAudioLanguage: en
  recordingDate: 2026-11-15
  playlists: [PL123]
  localizations:
    es: { title: "Mi Título", description: "Hola" }
`,
		);
		expect(metadata.title).toBe("My Title");
		expect(metadata.youtube?.categoryId).toBe("20");
		expect(metadata.youtube?.publishAt).toBe("2026-12-01T17:00:00Z");
		expect(metadata.youtube?.recordingDate).toBe("2026-11-15");
		expect(metadata.youtube?.localizations?.es?.title).toBe("Mi Título");
	});

	it("accepts JSON", async () => {
		const metadata = await load(
			"metadata.json",
			'{"title": "From JSON", "youtube": {"privacy": "unlisted"}}',
		);
		expect(metadata).toEqual({
			title: "From JSON",
			youtube: { privacy: "unlisted" },
		});
	});

	it.each([
		["unknown top-level key", "titel: typo"],
		["unknown youtube key", "youtube:\n  privcy: public"],
		["bad enum value", "youtube:\n  privacy: pubic"],
		[
			"publishAt with public privacy",
			"youtube:\n  privacy: public\n  publishAt: 2026-12-01T17:00:00Z",
		],
		["publishAt without timezone", "youtube:\n  publishAt: 2026-12-01 17:00"],
		["invalid YAML", "title: [unclosed"],
	])("rejects %s", async (_name, content) => {
		await expect(load("metadata.yaml", content)).rejects.toThrow(
			ValidationError,
		);
	});
});

describe("buildDescription", () => {
	it("joins header, description and footer with blank lines", async () => {
		const configDir = await tempDir();
		await writeFiles(configDir, {
			[HEADER_FILE]: "\uFEFFHeader\r\n",
			[FOOTER_FILE]: "\nFooter\n",
			"description.txt": "Body line 1\r\nBody line 2\n\n",
		});
		const description = await buildDescription({
			configDir,
			descriptionFile: path.join(configDir, "description.txt"),
		});
		expect(description).toBe("Header\n\nBody line 1\nBody line 2\n\nFooter");
	});

	it("skips missing parts and parts that are turned off", async () => {
		const configDir = await tempDir();
		await writeFiles(configDir, {
			[HEADER_FILE]: "Header",
			[FOOTER_FILE]: "Footer",
		});
		expect(await buildDescription({ configDir, includeHeader: false })).toBe(
			"Footer",
		);
		expect(
			await buildDescription({ configDir: path.join(configDir, "missing") }),
		).toBe("");
	});
});

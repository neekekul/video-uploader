import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { errorMessage, ValidationError } from "../errors.js";
import { type Metadata, metadataSchema } from "./schema.js";

/** Reads and validates a metadata file. The YAML parser also accepts JSON. */
export async function loadMetadata(
	file: string | undefined,
): Promise<Metadata> {
	if (file === undefined) return {};

	let raw: unknown;
	try {
		raw = parse(await readFile(file, "utf8"));
	} catch (error) {
		throw new ValidationError([
			`Could not parse metadata file: ${errorMessage(error)}`,
		]);
	}
	// An empty file parses to null; treat it as "no options".
	if (raw === null || raw === undefined) return {};

	const result = metadataSchema.safeParse(raw);
	if (!result.success) {
		throw new ValidationError([
			`Invalid metadata:\n${z.prettifyError(result.error)}`,
		]);
	}
	return result.data;
}

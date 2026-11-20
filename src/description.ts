import { readFile } from "node:fs/promises";
import path from "node:path";

export const HEADER_FILE = "description-header.txt";
export const FOOTER_FILE = "description-footer.txt";

export interface DescriptionInput {
	configDir: string;
	descriptionFile?: string | undefined;
	includeHeader?: boolean | undefined;
	includeFooter?: boolean | undefined;
}

/**
 * Joins the configured header, the archive's description.txt and the configured
 * footer, separated by blank lines. Missing or empty parts are skipped.
 */
export async function buildDescription(
	input: DescriptionInput,
): Promise<string> {
	const parts = await Promise.all([
		input.includeHeader === false
			? undefined
			: readOptional(path.join(input.configDir, HEADER_FILE)),
		input.descriptionFile === undefined
			? undefined
			: readOptional(input.descriptionFile),
		input.includeFooter === false
			? undefined
			: readOptional(path.join(input.configDir, FOOTER_FILE)),
	]);
	return parts
		.map((part) =>
			part
				?.replace(/^\uFEFF/, "")
				.replaceAll("\r\n", "\n")
				.trim(),
		)
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
}

async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export type ArchiveFormat = "zip" | "tar.gz";

const SUFFIXES: [string, ArchiveFormat][] = [
	[".tar.gz", "tar.gz"],
	[".tgz", "tar.gz"],
	[".zip", "zip"],
];

/** Returns the archive format and the file name without its archive suffix, or null if unsupported. */
export function parseArchiveName(
	fileName: string,
): { format: ArchiveFormat; baseName: string } | null {
	const lower = fileName.toLowerCase();
	for (const [suffix, format] of SUFFIXES) {
		if (lower.endsWith(suffix) && lower.length > suffix.length) {
			return { format, baseName: fileName.slice(0, -suffix.length) };
		}
	}
	return null;
}

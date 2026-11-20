/**
 * The archive itself is invalid (missing video, bad metadata, ...).
 * Retrying cannot help, so the archive goes straight to failed/.
 */
export class ValidationError extends Error {
	readonly problems: string[];

	constructor(problems: string[]) {
		super(problems.join("; "));
		this.name = "ValidationError";
		this.problems = problems;
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

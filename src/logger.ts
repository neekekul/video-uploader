export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

function line(level: string, message: string): string {
	return `${new Date().toISOString()} [${level}] ${message}`;
}

export const consoleLogger: Logger = {
	info: (message) => console.log(line("info", message)),
	warn: (message) => console.warn(line("warn", message)),
	error: (message) => console.error(line("error", message)),
};

export const silentLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

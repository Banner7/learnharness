import * as fs from "node:fs";
import * as path from "node:path";

/** A whole-record replacement: a crash cannot leave the destination half-written. */
export function writeAtomicFile(file: string, content: string): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(tmp, "wx", 0o600);
		fs.writeFileSync(fd, content, "utf-8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(tmp, file);
		// Persist the directory entry as well as the file contents.
		fsyncDirectory(dir);
	} catch (err) {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(tmp);
		} catch (cleanupErr) {
			if (!isMissingFile(cleanupErr)) throw cleanupErr;
		}
		throw err;
	}
}

export function fsyncDirectory(dir: string): void {
	const fd = fs.openSync(dir, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

export function isMissingFile(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

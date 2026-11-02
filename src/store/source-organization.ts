import fs from "node:fs";
import { SOURCE_ORGANIZATION_FILE } from "../../config.ts";
import { emptySourceOrganization, parseSourceOrganization } from "../core/source-organization.ts";
import type { SourceOrganizationStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { writeAtomicFile } from "./atomic-file.ts";

export const sourceOrganizationStore: SourceOrganizationStore = {
	read() {
		assertGraphFormat();
		let raw: string;
		try { raw = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySourceOrganization();
			throw error;
		}
		return parseSourceOrganization(JSON.parse(raw));
	},
	write(state) {
		assertGraphFormat();
		const valid = parseSourceOrganization(state);
		ensureGraphFormat();
		// The shared atomic writer (audit fix, 2026-11-03): the hand-rolled
		// temp+rename never fsynced, so a power cut could leave an empty file
		// that failed every /api/graph read until repaired by hand.
		writeAtomicFile(SOURCE_ORGANIZATION_FILE, JSON.stringify(valid, null, "\t") + "\n");
		emit("sources-changed", {});
	},
};

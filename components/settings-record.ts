import type { UserSettings } from "@/src/core";

let inFlight: Promise<{ settings: UserSettings | null }> | undefined;
let generation = 0;

export function invalidateSettingsRead(): void {
	generation++;
	inFlight = undefined;
}

/** One in-flight read (2026-10-31): appearance, model controls and coverage
 * mount together; they need the same server snapshot, not three full GETs.
 * Settle clears the slot so writes and later re-reads always fetch fresh truth. */
export function readSettingsRecord(): Promise<{ settings: UserSettings | null }> {
	if (inFlight) return inFlight;
	const requestGeneration = generation;
	const request = fetch("/api/settings")
		.then(async (response) => {
			if (!response.ok) throw new Error(`Settings unavailable (${response.status})`);
			const body = await response.json() as { settings: UserSettings | null };
			// A write can race a mount read; never publish its older record
			// after the write has notified every live consumer.
			if (generation !== requestGeneration) throw new Error("Settings read superseded by a write");
			return body;
		})
		.finally(() => { if (inFlight === request) inFlight = undefined; });
	inFlight = request;
	return request;
}

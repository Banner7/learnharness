/**
 * Vault wikilinks (fork, 2026-11-01): the vault library's notes reference
 * each other with Obsidian-style `[[wikilinks]]`. This module is pure —
 * parsing the syntax out of note text and resolving raw targets against the
 * present note set are both deterministic and file-free, so the server's
 * snapshot derivation can re-resolve links on every read without touching
 * the vault (only the scanner parses file bytes, and only when they change).
 *
 * Syntax handled: `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`,
 * `[[folder/Target]]`, and their combinations (`[[folder/Target#h|alias]]`).
 * Ignored: embeds `![[…]]`, and anything inside fenced code blocks or
 * inline code spans — links in prose only.
 */

/** One parsed link: the note path portion plus optional alias/heading. */
export interface Wikilink {
	/** The path part — `folder/Target` in `[[folder/Target#h|alias]]`. */
	target: string;
	/** Display alias after the last `|`, when present. */
	alias?: string;
	/** Heading anchor after the first `#`, when present. */
	heading?: string;
}

/** `[[target#heading|alias]]` → { target, heading, alias }. */
function parseInner(inner: string): Wikilink | null {
	let text = inner;
	let alias: string | undefined;
	let heading: string | undefined;
	const bar = text.lastIndexOf("|");
	if (bar !== -1) {
		alias = text.slice(bar + 1).trim() || undefined;
		text = text.slice(0, bar);
	}
	const hash = text.indexOf("#");
	if (hash !== -1) {
		heading = text.slice(hash + 1).trim() || undefined;
		text = text.slice(0, hash);
	}
	const target = text.trim();
	if (!target) return null;
	return { target, alias, heading };
}

/** Scan one non-fenced line, skipping inline-code spans and embeds. */
function parseLineLinks(line: string, out: Wikilink[]): void {
	let i = 0;
	while (i < line.length) {
		const ch = line[i]!;
		if (ch === "`") {
			// An inline code span: skip to its matching backtick run.
			let run = 1;
			while (line[i + run] === "`") run++;
			const closer = "`".repeat(run);
			const end = line.indexOf(closer, i + run);
			i = end === -1 ? line.length : end + run;
			continue;
		}
		if (ch === "!" && line[i + 1] === "[" && line[i + 2] === "[") {
			// An embed `![[…]]` is a reference, not a link — skip it whole.
			const end = line.indexOf("]]", i + 2);
			i = end === -1 ? line.length : end + 2;
			continue;
		}
		if (ch === "[" && line[i + 1] === "[") {
			const end = line.indexOf("]]", i + 2);
			if (end === -1) break;
			const link = parseInner(line.slice(i + 2, end));
			if (link) out.push(link);
			i = end + 2;
			continue;
		}
		i++;
	}
}

/** Every wikilink in the markdown, in document order, prose only. */
function parseWikilinks(markdown: string): Wikilink[] {
	const links: Wikilink[] = [];
	const lines = markdown.split(/\r?\n/);
	let fenceChar: "`" | "~" | null = null;
	for (const line of lines) {
		// Fenced code blocks: ``` or ~~~, up to three leading spaces.
		const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			const ch = fence[1]![0] as "`" | "~";
			if (fenceChar === null) {
				fenceChar = ch;
			} else if (fenceChar === ch && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) {
				fenceChar = null;
			}
			continue;
		}
		if (fenceChar !== null) continue;
		parseLineLinks(line, links);
	}
	return links;
}

/** Raw link targets (the path portions), deduped in document order — what
 *  the vault scanner stores alongside each note's sync state. */
export function parseWikilinkTargets(markdown: string): string[] {
	const seen = new Set<string>();
	const targets: string[] = [];
	for (const link of parseWikilinks(markdown)) {
		if (seen.has(link.target)) continue;
		seen.add(link.target);
		targets.push(link.target);
	}
	return targets;
}

// ─── note path helpers ─────────────────────────────────────────────────────

function stripMd(path: string): string {
	return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

/** A note's display title: the file basename without `.md`. */
export function noteTitle(path: string): string {
	return basename(stripMd(path));
}

/** A note's folder relative to the vault root ("" at the root). */
export function noteFolder(path: string): string {
	return dirname(path);
}

// ─── resolution (re-run per snapshot) ──────────────────────────────────────

/** One note's identity and its stored raw targets, for resolution. */
export interface NoteLinkSource {
	id: string;
	path: string;
	targets: readonly string[];
}

function normalizeTarget(target: string): string {
	return target.replace(/\\/g, "/").trim().replace(/^\/+/, "");
}

/**
 * Resolve raw targets to note ids, Obsidian-style: the exact relative path
 * (with or without `.md`) wins — tried against the note's own folder first,
 * then against the vault root — and only then a unique case-insensitive
 * basename match; an ambiguous basename resolves to the shortest path.
 * Missing, skipped/excluded and self links drop, and pairs dedupe.
 */
export function resolveNoteLinks(notes: readonly NoteLinkSource[]): { from: string; to: string }[] {
	const pathExact = new Map<string, string>();
	const byBasename = new Map<string, { id: string; path: string }[]>();
	for (const n of notes) {
		pathExact.set(stripMd(n.path), n.id);
		const base = basename(stripMd(n.path)).toLowerCase();
		let list = byBasename.get(base);
		if (!list) {
			list = [];
			byBasename.set(base, list);
		}
		list.push({ id: n.id, path: n.path });
	}

	const resolveTarget = (dir: string, target: string): string | null => {
		for (const candidate of dir ? [`${dir}/${target}`, target] : [target]) {
			const id = pathExact.get(stripMd(candidate));
			if (id !== undefined) return id;
		}
		const base = basename(stripMd(target)).toLowerCase();
		const matches = byBasename.get(base);
		if (!matches || matches.length === 0) return null;
		if (matches.length === 1) return matches[0]!.id;
		let best = matches[0]!;
		for (const m of matches) if (m.path.length < best.path.length) best = m;
		return best.id;
	};

	const links: { from: string; to: string }[] = [];
	const seen = new Set<string>();
	for (const note of notes) {
		const dir = dirname(note.path);
		for (const raw of note.targets) {
			const target = normalizeTarget(raw);
			if (!target) continue;
			const to = resolveTarget(dir, target);
			if (!to || to === note.id) continue;
			const key = `${note.id}\u0000${to}`;
			if (seen.has(key)) continue;
			seen.add(key);
			links.push({ from: note.id, to });
		}
	}
	return links;
}

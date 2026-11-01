/**
 * Researcher PDF capability (PDF wave, 2026-10-07, design B): web_fetch_pdf
 * downloads a PDF into a per-job temp dir and returns the triage summary;
 * pdf_info/pdf_extract/pdf_search read it page-level, ALL scoped to the dir
 * (the researcher's filesystem ends at the temp wall). web_fetch gained the
 * PDF POINTER (no dead-end) and the Source line with final URL + HTTP
 * status (200-served error bodies must be distinguishable from real pages).
 *
 * Zero network: globalThis.fetch is stubbed with a REAL minimal PDF built
 * programmatically (correct xref offsets — pdfjs parses it like any
 * download).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createPdfReadTools } from "../src/agent/tools/pdf-read.ts";
import { createWebTools } from "../src/agent/tools/web.ts";

/** Build a valid N-page PDF in memory — ASCII-only so string offsets ARE
 *  byte offsets; xref entries computed as we assemble. */
function buildPdf(pageTexts: string[]): Uint8Array {
	const objects: string[] = []; // 1-indexed
	const pageIds = pageTexts.map((_, i) => 3 + i * 2);
	const fontId = 3 + pageTexts.length * 2;
	objects[1] = "<</Type/Catalog/Pages 2 0 R>>";
	objects[2] = `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(" ")}]/Count ${pageTexts.length}>>`;
	pageTexts.forEach((text, i) => {
		const pageId = pageIds[i]!;
		const contentId = pageId + 1;
		const escaped = text.replace(/([()\\])/g, "\\$1");
		const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
		objects[pageId] =
			`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentId} 0 R` +
			`/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`;
		objects[contentId] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
	});
	objects[fontId] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";

	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = pdf.length;
		pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xrefStart = pdf.length;
	pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++) {
		pdf += `${String(offsets[id]!).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

const PDF_BYTES = buildPdf([
	"Hello PDF page one — the triage summary should see this.",
	"Page two holds the orthogonal complement theorem statement.",
]);

/** A fresh Response per call (bodies are single-use). */
const pdfResponse = () =>
	new Response(PDF_BYTES.slice().buffer as ArrayBuffer, { headers: { "content-type": "application/pdf" } });

/** Run fn with globalThis.fetch answering every request via respond. */
async function withFetch<T>(respond: () => Response, fn: () => Promise<T>): Promise<T> {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => respond()) as typeof fetch;
	try {
		return await fn();
	} finally {
		globalThis.fetch = realFetch;
	}
}

const tempDirs: string[] = [];
async function newDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-test-pdf-"));
	tempDirs.push(dir);
	return dir;
}
after(async () => {
	await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Tool-result .details → displayable string (the agent sees this shape). */
function asText(result: unknown): string {
	const r = result as { details?: unknown };
	if (typeof r?.details === "string") return r.details;
	return JSON.stringify(r?.details ?? r);
}

describe("researcher pdf tools", () => {
	it("web_fetch_pdf downloads + triages; info/extract/search read the download page-level", async () => {
		const tools = createPdfReadTools(await newDir());
		const out = await withFetch(pdfResponse, () => tools.web_fetch_pdf!.execute!("t1", { url: "https://arxiv.org/pdf/2406.14058" }));
		assert.match(asText(out), /"page_count":2/);
		const { path: pdfPath } = (out as { details: { path: string } }).details;
		assert.equal((await fs.readFile(pdfPath)).byteLength, PDF_BYTES.byteLength, "the PDF bytes land on disk");

		const info = asText(await tools.pdf_info!.execute!("t2", { path: pdfPath }));
		assert.match(info, /"page_count":2/);
		const extract = asText(await tools.pdf_extract!.execute!("t3", { path: pdfPath, pages: "2" }));
		assert.match(extract, /orthogonal complement/);
		assert.ok(!extract.includes("page one"), "narrow specs extract only the asked pages");
		const search = asText(await tools.pdf_search!.execute!("t4", { path: pdfPath, query: "theorem" }));
		assert.match(search, /"page":2/);
	});

	it("rejects non-PDF responses and non-http(s) schemes with error strings", async () => {
		const tools = createPdfReadTools(await newDir());
		const notPdf = await withFetch(
			() => new Response("<html>just a page</html>", { headers: { "content-type": "text/html" } }),
			() => tools.web_fetch_pdf!.execute!("t5", { url: "https://example.com/doc" }),
		);
		assert.match(asText(notPdf), /Not a PDF/);
		assert.match(asText(await tools.web_fetch_pdf!.execute!("t6", { url: "ftp://example.com/x.pdf" })), /invalid URL/);
	});

	it("path-taking tools refuse anything outside the job dir (the temp-dir wall)", async () => {
		const tools = createPdfReadTools(await newDir());
		const outside = asText(await tools.pdf_info!.execute!("t7", { path: path.join(os.tmpdir(), "escape-attempt.pdf") }));
		assert.match(outside, /path must stay inside/);
		const traversal = asText(await tools.pdf_extract!.execute!("t8", { path: "../../etc/passwd", pages: "1" }));
		assert.match(traversal, /path must stay inside/);
	});
});

describe("web_fetch — PDF pointer + source header", () => {
	it("a PDF URL points at web_fetch_pdf instead of dead-ending", async () => {
		const web = createWebTools(() => null);
		const out = await withFetch(pdfResponse, () => web.web_fetch!.execute!("t11", { url: "https://example.com/paper.pdf" }));
		assert.match(asText(out), /web_fetch_pdf/);
	});

	it("output carries the source line with HTTP status", async () => {
		const web = createWebTools(() => null);
		const out = await withFetch(
			() => new Response("A plain text page with enough content to matter.", { headers: { "content-type": "text/plain" } }),
			() => web.web_fetch!.execute!("t12", { url: "https://example.com/page" }),
		);
		assert.match(asText(out), /^Source: https:\/\/example\.com\/page \(HTTP 200\)/);
	});
});

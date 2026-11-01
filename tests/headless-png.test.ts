import assert from "node:assert/strict";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { providerSafePng } from "../src/agent/subagents/headless.ts";

/**
 * The 2026-09-19 visual-maker fix (the "image format is illegal" 400s):
 * Chrome writes PNGs with a SPLIT IDAT stream; Alibaba's vision decoder
 * rejected those while every single-IDAT form passed. providerSafePng
 * merges the split back into the canonical ONE-IDAT form (PNG spec: the
 * IDAT chunks are an arbitrary split of ONE zlib stream). App code carries
 * no image library, so these tests use a spec-level PNG toolchain.
 */

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf: Buffer): number {
	let c = ~0;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** Chunks with their CRCs verified. */
function walkChunks(png: Buffer): Array<{ type: string; data: Buffer }> {
	assert.ok(png.subarray(0, 8).equals(PNG_SIG), "PNG signature");
	const chunks: Array<{ type: string; data: Buffer }> = [];
	let off = 8;
	while (off < png.length) {
		const len = png.readUInt32BE(off);
		const type = png.subarray(off + 4, off + 8).toString("ascii");
		assert.equal(png.readUInt32BE(off + 8 + len), crc32(png.subarray(off + 4, off + 8 + len)), `valid CRC on ${type}`);
		chunks.push({ type, data: png.subarray(off + 8, off + 8 + len) });
		off += 12 + len;
	}
	return chunks;
}

/** 4×4 white RGB scanlines (filter byte 0 per row). */
const RAW = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array<number>(12).fill(255)])));

/** A valid PNG whose compressed scanlines are split across `idats` chunks (Chrome's shape at 2). */
function png(idats: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(4, 0);
	ihdr.writeUInt32BE(4, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB
	const compressed = zlib.deflateSync(RAW);
	const size = Math.ceil(compressed.length / idats);
	const parts = Array.from({ length: idats }, (_, i) => chunk("IDAT", compressed.subarray(i * size, (i + 1) * size)));
	return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), ...parts, chunk("IEND", Buffer.alloc(0))]);
}

test("providerSafePng merges a Chrome-style split IDAT stream into ONE chunk, byte-identical stream", () => {
	const chromeStyle = png(2);
	const inIdats = walkChunks(chromeStyle).filter((c) => c.type === "IDAT");
	assert.equal(inIdats.length, 2, "fixture sanity: the input is the multi-IDAT shape");

	const outChunks = walkChunks(providerSafePng(chromeStyle));
	assert.deepEqual(outChunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
	const stream = outChunks[1]!.data;
	assert.ok(stream.equals(Buffer.concat(inIdats.map((c) => c.data))), "the zlib stream is untouched");
	assert.ok(zlib.inflateSync(stream).equals(RAW), "inflates to the original raw scanlines");
});

test("canonical, non-PNG, or truncated input passes through byte-identical", () => {
	for (const input of [png(1), Buffer.from("definitely not a png"), png(2).subarray(0, 20)]) {
		assert.ok(providerSafePng(input).equals(input));
	}
});

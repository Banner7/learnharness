import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	root: fileURLToPath(new URL("./web", import.meta.url)),
	publicDir: fileURLToPath(new URL("./public", import.meta.url)),
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
	},
	build: {
		outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
		emptyOutDir: true,
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: {
			// Fork rewrite (2026-10-29): keep browser Host/Origin for the
			// private gate; http-proxy streams SSE without buffering a body.
			"/api": { target: `http://127.0.0.1:${process.env.PORT ?? "3000"}`, changeOrigin: false },
		},
	},
});

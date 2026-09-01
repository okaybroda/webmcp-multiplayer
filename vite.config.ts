import { defineConfig } from "vite";

export default defineConfig({
	build: { outDir: "dist", emptyOutDir: true, target: "es2022", rollupOptions: { input: { home: "index.html", document: "document/index.html", canvas: "canvas/index.html" } } },
});

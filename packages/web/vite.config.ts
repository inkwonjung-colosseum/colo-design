import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // One 630KB chunk cached as a unit: any app edit re-downloaded all of
        // React with it. Three vendor chunks mean an app change ships only the
        // app chunk on a daemon that serves no-store.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // pnpm's virtual store nests one node_modules per package
          // (.../node_modules/.pnpm/x@1/node_modules/x/…) — the LAST
          // segment is the package the module actually belongs to.
          const segments = id.split("node_modules/").pop()?.split("/");
          const name = segments?.[0]?.startsWith("@")
            ? `${segments[0]}/${segments[1]}`
            : segments?.[0];
          if (!name) return undefined;
          if (name === "react" || name === "react-dom" || name === "scheduler") return "react";
          // The markdown pipeline is a dependency cluster of its own —
          // react-markdown pulls unified/remark/micromark/hast, matched by
          // family prefix so one missed package name cannot strand it.
          if (
            name === "react-markdown" ||
            name === "remark-gfm" ||
            /^(remark|micromark|mdast|hast|unist|vfile|unified)/.test(name) ||
            ["property-information", "html-url-attributes", "devlop", "zwitch", "bail", "trough"].includes(name)
          ) {
            return "markdown";
          }
          return undefined;
        },
      },
    },
  },
  // Bind IPv4 explicitly. The default `localhost` resolves to ::1 only on
  // macOS, which makes the app unreachable at 127.0.0.1 while the daemon,
  // which binds 127.0.0.1, is reachable. Matching them avoids confusion.
  server: { host: "127.0.0.1", port: 5273, strictPort: true },
});

import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Strict Content-Security-Policy for the production build: scripts only from this site,
// network connections only to Telegram's own WebSocket servers.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' wss://*.web.telegram.org",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const csp = {
  name: "inject-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  base: "./", // works on any GitHub Pages path (user.github.io/<repo>/)
  plugins: [nodePolyfills({ include: ["buffer", "process", "util", "os", "events", "stream", "path", "crypto", "net", "constants"], globals: { Buffer: true, process: true } }), csp],
  build: {
    outDir: "dist",
    target: "es2020",
    chunkSizeWarningLimit: 2500,
  },
  // Local private use: `npm start` serves the built app on this computer only (127.0.0.1).
  preview: {
    host: "127.0.0.1",
    port: 8765,
    strictPort: true, // fixed address, so a remembered login and settings are found again
    headers: {
      "Content-Security-Policy": `${CSP}; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  },
  test: {
    environment: "node",
  },
});

// Serves dist/ on http://localhost:8788 so you can view dist/harness.html with sample data.
//   npm run build:widget && node scripts/serve-harness.mjs
// Then open http://localhost:8788/harness.html (add ?view=card or ?theme=dark).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.env.PORT ?? 8788);

createServer(async (req, res) => {
  const path = normalize(new URL(req.url ?? "/", "http://localhost").pathname).replace(/^([/\\])+/, "");
  const file = join(dist, path || "harness.html");
  const rel = relative(dist, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Harness: http://localhost:${port}/harness.html`));

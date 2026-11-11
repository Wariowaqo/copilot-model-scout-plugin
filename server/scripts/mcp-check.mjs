// Minimal MCP client for checking this server. Only talks to the URL you pass.
//   node scripts/mcp-check.mjs http://127.0.0.1:8787/mcp              # initialize, tools/list, resources/read
//   node scripts/mcp-check.mjs <url> --tools-json out.json             # save tools/list for the Cowork tool-description file
//   node scripts/mcp-check.mjs <url> --call show_model_card '{"model_id":"Qwen/Qwen3-8B"}'
//   node scripts/mcp-check.mjs <url> --origin <hostname>               # send a browser Origin header
const [url, ...rest] = process.argv.slice(2);
if (!url) { console.error("usage: node scripts/mcp-check.mjs <mcp-url> [--tools-json file] [--call tool json] [--origin host]"); process.exit(2); }
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest.slice(i + 1) : null; };
const origin = flag("--origin")?.[0];

let id = 0;
let sessionId = null;
const headers = () => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
  ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  ...(origin ? { origin: `https://${origin}` } : {}),
});
async function notify(method, params) {
  await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) });
}
async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  // Session-based servers return an id on initialize that must be sent on later requests.
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
  // Response may be JSON or a single SSE event.
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
  const msg = JSON.parse(json);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
  clientInfo: { name: "mcp-check", version: "0.1.0" },
});
console.log(`server: ${init.serverInfo?.name} ${init.serverInfo?.version} · protocol ${init.protocolVersion}`);
await notify("notifications/initialized");

const { tools } = await rpc("tools/list", {});
for (const t of tools) {
  console.log(`tool ${t.name}: readOnly=${t.annotations?.readOnlyHint} ui=${t._meta?.ui?.resourceUri ?? "-"} inputs=${Object.keys(t.inputSchema?.properties ?? {}).join(",")}`);
}

const toolsJson = flag("--tools-json")?.[0];
if (toolsJson) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(toolsJson, JSON.stringify({ tools }, null, 2) + "\n");
  console.log(`wrote ${toolsJson}`);
}

const uris = [...new Set(tools.map((t) => t._meta?.ui?.resourceUri).filter(Boolean))];
for (const uri of uris) {
  const r = await rpc("resources/read", { uri });
  const c = r.contents?.[0];
  console.log(`resource ${uri}: ${c?.mimeType} · ${(c?.text?.length / 1024).toFixed(1)} KB · meta=${JSON.stringify(c?._meta ?? {})}`);
}

const call = flag("--call");
if (call) {
  const [name, args = "{}"] = call;
  const t0 = Date.now();
  const r = await rpc("tools/call", { name, arguments: JSON.parse(args) });
  console.log(`call ${name} (${Date.now() - t0} ms) isError=${Boolean(r.isError)}`);
  console.log(r.content?.find((c) => c.type === "text")?.text);
  if (r.structuredContent) console.log("structuredContent keys:", Object.keys(r.structuredContent).join(", "));
}

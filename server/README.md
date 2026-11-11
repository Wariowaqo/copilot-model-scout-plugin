# Model Scout MCP server

A small MCP server with a live **MCP Apps** widget for Microsoft 365 Copilot (and any other MCP Apps host).
Give it a Hugging Face model id and it renders an interactive model card:

- Parameters, size on disk, downloads, likes, license, last update, GGUF files
- Memory needed at each quantization level (FP16 → Q2_K), with a plain-language explanation of each
- A context-length slider and a "will it run on my machine?" check against your RAM and GPU memory
- Buttons that call back into the chat: Refresh, Full screen, Open on Hugging Face, Deploy on Azure

It runs on Cloudflare Workers (free tier), needs no sign-in, and stores nothing. It reads only public
data from the [Hugging Face Hub API](https://huggingface.co/docs/hub/api).

Used by the **AI Model Scout** plugin in [`../plugin`](../plugin).

## Tools

All tools are annotated `readOnlyHint: true`, so Copilot Cowork runs them without a confirmation prompt.

| Tool | Widget | What it does |
| --- | --- | --- |
| `show_model_card(model_id, quantization?, context_length?)` | ✅ | Live card for one model |
| `compare_models(model_ids[2–3], quantization?, context_length?)` | ✅ | Side-by-side comparison; select a model to open its card |
| `estimate_hardware(model_id, quantization?, context_length?, ram_gb?, vram_gb?)` | – | Text-only memory estimate and fit check |

Every tool also returns plain text and `structuredContent`, so hosts that don't render widgets
(such as Cowork) still get a useful answer.

## How the estimate works

```
memory ≈ parameters × bits per weight ÷ 8
       + KV cache  (2 × layers × KV heads × head size × 2 bytes × context length)
       + ~5% of weights + 0.5 GB runtime overhead
```

Parameter counts come from the repo's safetensors or GGUF metadata. Layer and head counts come from
`config.json`; when that isn't readable (for example on gated repos), the KV cache is scaled from a typical
8B model and labelled "rough". Bits per weight are approximate llama.cpp figures. **These are estimates.**
Real usage depends on the runtime (llama.cpp, Ollama, vLLM, MLX) and settings.

## Run locally

```powershell
npm install
npm test                 # unit tests for the estimate maths and input validation
npm run typecheck        # builds the widget, type-checks server and widget
npm run dev              # wrangler dev on http://127.0.0.1:8787/mcp
```

Check the server with the included minimal client (it only talks to the URL you pass):

```powershell
node scripts/mcp-check.mjs http://127.0.0.1:8787/mcp
node scripts/mcp-check.mjs http://127.0.0.1:8787/mcp --call show_model_card '{"model_id":"Qwen/Qwen3-8B"}'
```

View the widget with sample data, without a host:

```powershell
npm run build:widget
node scripts/serve-harness.mjs
# open http://localhost:8788/harness.html  (add ?view=card or ?theme=dark)
```

## Deploy your own copy

```powershell
npx wrangler login
npm run deploy
```

Your endpoint is `https://model-scout-mcp.<your-subdomain>.workers.dev/mcp`. Open the root URL
(`/`) to see the Copilot widget host the server allows.

## Copilot widget host (CORS)

Microsoft 365 Copilot renders widgets under
`{sha256 of your server domain}.widget-renderer.usercontent.microsoft.com`, and calls from the widget
carry that Origin. The server computes this from its own hostname and allows it. If Microsoft's
[Widget Host URL Generator](https://aka.ms/mcpwidgeturlgenerator) shows a different value for your
URL, add it to `EXTRA_ORIGIN_HOSTNAMES` in `wrangler.jsonc`. Other browser Origins get a 403.
Requests without an Origin (normal MCP clients) are always accepted.

## Security notes

- Model ids must match `owner/name`; URLs, path traversal, and anything else are rejected.
- The Worker only fetches `huggingface.co`, with an 8-second timeout. Responses are cached for 10 minutes
  to stay inside Hugging Face's anonymous rate limits.
- Hub data is treated as untrusted: the widget inserts it with `textContent`, never as HTML. The widget
  loads no external scripts, styles, or fonts.
- Hub metadata that model authors write (license, task, library, author, file names) is reduced to a
  safe character set before it reaches the agent, so a model repo can't inject markdown, links, or
  instructions into the tool text (indirect prompt injection).
- The widget only opens `https://huggingface.co` links, whatever the tool result contains.
- **Auth is `None`.** That's fine for a public, read-only demo. Microsoft's docs describe anonymous auth
  as a development option; add OAuth 2.1 or Entra SSO before a production or store release.
- **No rate limit.** Anyone who knows your Worker URL can call it, and each call makes up to three
  Hugging Face requests. If you expect traffic, add a
  [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
  or Cloudflare WAF rules.
- The Origin allow-list also accepts `localhost` and `127.0.0.1` so local tools can call the
  deployed server. Remove them in `src/index.ts` if you don't need that.

## Project layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | Worker entry: routing and Origin allow-list |
| `src/server.ts` | MCP server: tools and the `ui://` widget resource |
| `src/hf.ts` | Hugging Face Hub reader and input validation |
| `src/shared/estimate.ts` | Memory estimate maths, shared by server and widget |
| `src/shared/links.ts` | The widget's Hugging Face-only link check |
| `src/widget/` | Widget source (HTML, CSS, TypeScript) |
| `scripts/build-widget.mjs` | Bundles the widget into one self-contained HTML file |
| `test/` | Unit tests and the harness sample data |

## Credits

Model data: [Hugging Face Hub](https://huggingface.co). Widget bridge:
[MCP Apps SDK](https://github.com/modelcontextprotocol/ext-apps). Not affiliated with Hugging Face or Microsoft.

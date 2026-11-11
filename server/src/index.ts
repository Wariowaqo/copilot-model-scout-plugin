import { createMcpHandler } from "agents/mcp/server";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";

interface Env {
  /**
   * Optional comma-separated extra browser Origin hostnames to accept, for example the
   * value shown by Microsoft's Widget Host URL Generator if it differs from the computed one.
   */
  EXTRA_ORIGIN_HOSTNAMES?: string;
}

type Handler = ReturnType<typeof createMcpHandler>;
const handlers = new Map<string, Handler>();

/**
 * Microsoft 365 Copilot renders widgets under
 * `{sha256 of the MCP server domain}.widget-renderer.usercontent.microsoft.com`.
 * Calls from the widget carry that Origin, so it must be allowed.
 */
export async function copilotWidgetHost(serverHostname: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serverHostname.toLowerCase()));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}.widget-renderer.usercontent.microsoft.com`;
}

async function handlerFor(hostname: string, env: Env): Promise<Handler> {
  const cached = handlers.get(hostname);
  if (cached) return cached;
  const extra = (env.EXTRA_ORIGIN_HOSTNAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const handler = createMcpHandler(createServer, {
    route: "/mcp",
    allowedOriginHostnames: [hostname, "localhost", "127.0.0.1", await copilotWidgetHost(hostname), ...extra],
  });
  handlers.set(hostname, handler);
  return handler;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        `${SERVER_NAME} ${SERVER_VERSION}\n\nMCP endpoint: ${url.origin}/mcp\nCopilot widget host: ${await copilotWidgetHost(url.hostname)}\n\nReads public model metadata from the Hugging Face Hub. No sign-in, no data stored.\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const handler = await handlerFor(url.hostname, env);
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

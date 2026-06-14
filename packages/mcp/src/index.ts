import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  API_BASE_URL: string;
}

const TOOL_TIMEOUT_MS = 8000;

async function fetchCollection(apiBase: string, collection: string, slug?: string) {
  const params = slug ? `?slug=${encodeURIComponent(slug)}` : "";
  const url = `${apiBase}/api/${collection}${params}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { error: `API returned status ${response.status}` };
  }
  return await response.json();
}

function buildServer(apiBase: string) {
  const server = new McpServer({
    name: "varsana-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "get_collection",
    {
      description:
        "Consulta datos de una coleccion de Varsana: 'events', 'pasadias', 'nosotros'. Sin slug devuelve hasta 5 entradas. Con slug devuelve el detalle completo.",
      inputSchema: {
        collection: z.enum(["events", "pasadias", "nosotros"]),
        slug: z.string().optional().describe("Slug para detalle completo"),
      },
    },
    async ({ collection, slug }) => {
      const data = await fetchCollection(
        apiBase,
        collection as string,
        slug ?? undefined,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", mcp: "varsana" });
    }
    // Test: just return OK without MCP to verify the Worker works
    if (url.pathname === "/test") {
      return Response.json({ ok: true, apiBase: env.API_BASE_URL });
    }
    try {
      const handler = createMcpHandler(
        buildServer(env.API_BASE_URL),
        { route: "/mcp" },
      );
      return handler(request, env);
    } catch (err: any) {
      return new Response("MCP Error: " + (err.message || "unknown"), { status: 500 });
    }
  },
};

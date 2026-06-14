import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  API_BASE_URL: string;
  VarsanaMcpAgent: DurableObjectNamespace;
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

export class VarsanaMcpAgent extends McpAgent<Env> {
  async init(): Promise<void> {}

  get server(): McpServer {
    const apiBase = this.env.API_BASE_URL;
    const mcp = new McpServer({
      name: "varsana-mcp",
      version: "1.0.0",
    });

    mcp.registerTool(
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

    return mcp;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", mcp: "varsana" });
    }
    // Delegate to the DO
    const ns = env.VarsanaMcpAgent;
    const id = ns.idFromName("mcp");
    const stub = ns.get(id);
    return stub.fetch(request);
  },
};

import { tool } from "ai";
import { z } from "zod";

export const TOOL_TIMEOUT_MS = 8000;

/**
 * Shared fetch helper for all tools. Each tool queries an API endpoint
 * on the client's website (e.g. /api/collections, /api/pasadias).
 */
export async function fetchToolData(
  toolsUrl: string | undefined,
  name: string,
  args: Record<string, any>,
): Promise<string> {
  if (!toolsUrl) return JSON.stringify({ error: "Tools not configured" });
  try {
    let url: string;
    if (name === "get_collections") {
      url = `${toolsUrl}/api/collections`;
    } else if (name === "query_collection") {
      const slug = args.slug ? `?slug=${encodeURIComponent(args.slug)}` : "";
      url = `${toolsUrl}/api/${encodeURIComponent(args.collection)}${slug}`;
    } else {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
    if (!res.ok) return JSON.stringify({ error: `Status ${res.status}` });
    return await res.text();
  } catch (err: any) {
    return JSON.stringify({ error: err.message || "Tool failed" });
  }
}

/** All available tools. Add new tools here — they auto-register with Think. */
export function buildTools(toolsUrl: string | undefined) {
  return {
    get_collections: tool({
      description:
        "Descubre todas las colecciones de contenido disponibles (events, pasadias, nosotros) con sus campos y endpoints.",
      inputSchema: z.object({}),
      execute: async () => fetchToolData(toolsUrl, "get_collections", {}),
    }),
    query_collection: tool({
      description:
        "Consulta una coleccion. Usa 'collection' (nombre) y opcionalmente 'slug' para detalle.",
      inputSchema: z.object({
        collection: z.string().describe("Nombre de la coleccion"),
        slug: z.string().optional().describe("Slug para detalle"),
      }),
      execute: async (args: any) => fetchToolData(toolsUrl, "query_collection", args),
    }),
  };
}

/**
 * Tool definitions and execution helpers.
 *
 * Each tool maps to an API endpoint on the client's website. Adding a new
 * tool is just adding an entry to TOOL_DEFINITIONS — the execution logic
 * is generic and doesn't need to change.
 */

export const TOOL_TIMEOUT_MS = 8000;

export interface ToolDefinition {
  description: string;
  parameters: Record<string, unknown>;
  buildUrl: (args: Record<string, any>, toolsUrl: string) => string;
}

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  get_collections: {
    description: "Descubre todas las colecciones de contenido disponibles (ej: events, pasadias, nosotros) con sus campos y endpoints. Usa esto primero para saber que datos estan disponibles antes de consultar una coleccion especifica.",
    parameters: {
      type: "object",
      properties: {},
    },
    buildUrl: (_args, base) => `${base}/api/collections`,
  },
  query_collection: {
    description: "Consulta una coleccion de contenido especifica. Usa el parametro 'collection' con el nombre de la coleccion (ej: 'events', 'pasadias', 'nosotros'). Usa el parametro 'slug' para obtener el detalle completo de un registro especifico (opcional). Antes de usar esta tool, llama a get_collections para saber que colecciones existen.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Nombre de la coleccion a consultar (ej: 'events', 'pasadias', 'nosotros')" },
        slug: { type: "string", description: "Slug del registro para obtener detalle completo (opcional)" },
      },
      required: ["collection"],
    },
    buildUrl: (args, base) => {
      const slug = args.slug ? `?slug=${encodeURIComponent(args.slug)}` : "";
      return `${base}/api/${encodeURIComponent(args.collection)}${slug}`;
    },
  },
};

export async function executeToolCall(
  name: string,
  args: Record<string, any>,
  toolsUrl: string,
): Promise<string> {
  const def = TOOL_DEFINITIONS[name];
  if (!def) return JSON.stringify({ error: `Unknown tool: ${name}` });

  try {
    const url = def.buildUrl(args, toolsUrl);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    if (!response.ok) {
      return JSON.stringify({ error: `API returned status ${response.status}` });
    }
    return await response.text();
  } catch (err: any) {
    return JSON.stringify({ error: err.message || "Tool execution failed" });
  }
}

export function getTools(toolsUrl?: string): any[] | undefined {
  if (!toolsUrl) return undefined;
  return Object.entries(TOOL_DEFINITIONS).map(([name, def]) => ({
    type: "function" as const,
    function: { name, description: def.description, parameters: def.parameters },
  }));
}

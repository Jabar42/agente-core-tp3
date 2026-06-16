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
  get_events: {
    description: "Lista los proximos eventos (retiros) disponibles con titulos, fechas, precios y disponibilidad. Usa el parametro slug para obtener el detalle completo de un evento especifico incluyendo la descripcion detallada.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug del evento para obtener detalle completo (opcional)" },
      },
    },
    buildUrl: (args, base) => {
      const slug = args.slug ? `?slug=${encodeURIComponent(args.slug)}` : "";
      return `${base}/api/events${slug}`;
    },
  },
  get_pasadias: {
    description: "Lista los pasadias (experiencias de un dia) disponibles con titulos, precios, duracion y categoria. Usa el parametro slug para obtener el detalle completo de un pasadia especifico.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug del pasadia para obtener detalle completo (opcional)" },
      },
    },
    buildUrl: (args, base) => {
      const slug = args.slug ? `?slug=${encodeURIComponent(args.slug)}` : "";
      return `${base}/api/pasadias${slug}`;
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

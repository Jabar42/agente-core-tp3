/**
 * Admin API helpers. Each function receives `env` and returns a Response.
 * They work by getting a DO stub (singleton per client) and calling RPC
 * methods on the Tp3ChatAgent Durable Object.
 */

interface Env {
  AI_GATEWAY_TOKEN: string;
  CLIENT_ID: string;
  TOOLS_URL?: string;
  Tp3ChatAgent: DurableObjectNamespace;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function error(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

function getStub(env: Env): any {
  // Use a fixed DO name so all chat sessions + admin queries hit the same DO instance
  const doId = env.Tp3ChatAgent.idFromName("dashboard");
  return env.Tp3ChatAgent.get(doId);
}

export async function handleStats(env: Env, url: URL): Promise<Response> {
  try {
    const clientId = url.searchParams.get("client") || env.CLIENT_ID || "tp3studio";
    const stub = getStub(env);
    const data = await stub.adminGetStats(clientId);
    return json(data);
  } catch (err: any) {
    return error(err.message || "Failed to fetch stats", 500);
  }
}

export async function handleConversations(env: Env, url: URL): Promise<Response> {
  try {
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const stub = getStub(env);
    const data = await stub.adminGetConversations(limit, offset);
    return json(data);
  } catch (err: any) {
    return error(err.message || "Failed to fetch conversations", 500);
  }
}

export async function handleConversation(env: Env, id: string): Promise<Response> {
  try {
    const stub = getStub(env);
    const data = await stub.adminGetConversation(id);
    return json(data);
  } catch (err: any) {
    return error(err.message || "Failed to fetch conversation", 500);
  }
}

export async function handleGetPrompts(env: Env, url: URL): Promise<Response> {
  try {
    const clientId = url.searchParams.get("client") || env.CLIENT_ID || "tp3studio";
    const stub = getStub(env);
    const data = await stub.adminGetPrompts(clientId);
    return json(data);
  } catch (err: any) {
    return error(err.message || "Failed to fetch prompts", 500);
  }
}

export async function handleSavePrompt(env: Env, request: Request): Promise<Response> {
  try {
    const body: any = await request.json();
    const { client_id, fragment, content } = body;
    if (!client_id || !fragment || content === undefined || content === null) {
      return error("Missing required fields: client_id, fragment, content");
    }
    if (!["SOUL", "SKILLS", "RULES", "CONTEXT"].includes(fragment)) {
      return error("Invalid fragment. Must be SOUL, SKILLS, RULES, or CONTEXT");
    }
    const stub = getStub(env);
    await stub.adminSavePrompt(client_id, fragment, content);
    return json({ ok: true });
  } catch (err: any) {
    return error(err.message || "Failed to save prompt", 500);
  }
}

export function handleCors(): Response {
  return new Response(null, { headers: corsHeaders });
}

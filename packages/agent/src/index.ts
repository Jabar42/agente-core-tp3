/// <reference types="@cloudflare/workers-types" />

import {
  Agent,
  routeAgentRequest,
  type Connection,
  type ConnectionContext,
} from "agents";
import { getSystemPrompt, DEFAULTS } from "./prompts";
import { getTools, executeToolCall } from "./tools";
import { overviewPage } from "./dashboard/overview";
import { conversationsPage } from "./dashboard/conversations";
import { promptsPage } from "./dashboard/prompts";
import {
  handleStats,
  handleConversations,
  handleConversation,
  handleGetPrompts,
  handleSavePrompt,
  handleCors,
} from "./dashboard/api";

interface Env {
  AI_GATEWAY_TOKEN: string;
  CLIENT_ID: string;
  TOOLS_URL?: string;
  Tp3ChatAgent: DurableObjectNamespace;
}

const AI_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/e3e57fcc48f7a3905b335a21ff5de958/tp3-gateway/compat/chat/completions";
const DEEPSEEK_TIMEOUT_MS = 25000;
/**
 * Non-streaming call to DeepSeek. Used by the HTTP /api/chat fallback.
 */
async function chatWithDeepSeek(
  gatewayToken: string,
  clientId: string,
  systemPrompt: string,
  messages: { role: string; content: string }[],
): Promise<string | null> {
  try {
    const response = await fetch(AI_GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gatewayToken}`,
        "cf-aig-metadata": `{"client":"${clientId}"}`,
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.slice(-20),
        ],
        max_tokens: 1024,
        temperature: 0.7,
        stream: false,
      }),
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const result: any = await response.json();
    return result.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

/**
 * Streaming call to DeepSeek via SSE.
 * Calls `onToken` for each content delta, then `onDone(fullText)` at the end.
 * Returns the full text, or null on failure.
 */
async function streamDeepSeek(
  gatewayToken: string,
  clientId: string,
  systemPrompt: string,
  messages: { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string }[],
  onToken: (delta: string) => void,
  onDone: (fullText: string) => void,
  tools?: any[],
  onToolCall?: (name: string, args: Record<string, any>) => Promise<string>,
): Promise<string | null> {
  try {
    const body: any = {
      model: "deepseek/deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.slice(-20),
      ],
      max_tokens: tools && tools.length > 0 ? 2048 : 1024,
      temperature: 0.7,
      stream: true,
    };
    if (tools && tools.length > 0) body.tools = tools;

    const response = await fetch(AI_GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gatewayToken}`,
        "cf-aig-metadata": `{"client":"${clientId}"}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
    });

    if (!response.ok || !response.body) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";
    // Accumulate tool call deltas by index
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    // State machine to strip XML tool call markup that DeepSeek may embed in content.
    // Must persist across chunks — regex per chunk can't match multi-chunk XML.
    let insideXML = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // Accumulate tool call deltas
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let acc = toolCalls.get(idx);
              if (!acc) {
                acc = { id: tc.id || "", name: "", arguments: "" };
                toolCalls.set(idx, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
            continue;
          }

          // Normal content delta — strip any XML markup before sending to widget
          if (delta.content && toolCalls.size === 0) {
            let clean = "";
            for (const ch of delta.content) {
              if (ch === "<") { insideXML = true; continue; }
              if (ch === ">") { insideXML = false; continue; }
              if (!insideXML) clean += ch;
            }
            if (clean) {
              fullText += clean;
              onToken(clean);
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }

    // Execute tool calls if any
    if (toolCalls.size > 0 && onToolCall) {
      const toolResults: { role: string; tool_call_id: string; content: string }[] = [];
      const assistantToolCalls: any[] = [];

      for (const [, acc] of toolCalls) {
        let args: Record<string, any> = {};
        try { args = JSON.parse(acc.arguments); } catch { args = {}; }
        const result = await onToolCall(acc.name, args);
        toolResults.push({ role: "tool", tool_call_id: acc.id, content: result });
        assistantToolCalls.push({
          id: acc.id, type: "function",
          function: { name: acc.name, arguments: acc.arguments },
        });
      }

      // Second call without tools to get the final response
      const newMessages = [
        ...messages.slice(-20),
        { role: "assistant", content: null, tool_calls: assistantToolCalls },
        ...toolResults,
      ];

      return await streamDeepSeek(
        gatewayToken, clientId, systemPrompt, newMessages,
        onToken, onDone,
        undefined, undefined, // no tools in second pass
      );
    }

    if (fullText) {
      onDone(fullText);
      return fullText;
    }
    return null;
  } catch {
    return null;
  }
}

export class Tp3ChatAgent extends Agent<Env> {
  /**
   * One-time DB initialization per DO instance. Creates analytics tables
   * if they don't exist yet.
   */
  async initDb() {
    this.sql`CREATE TABLE IF NOT EXISTS daily_metrics (
      date TEXT NOT NULL,
      client_id TEXT NOT NULL,
      messages INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      tool_errors INTEGER DEFAULT 0,
      PRIMARY KEY (date, client_id)
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      message_count INTEGER DEFAULT 0,
      last_message TEXT
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      name TEXT NOT NULL,
      args TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS runtime_prompts (
      client_id TEXT NOT NULL,
      fragment TEXT NOT NULL CHECK(fragment IN ('SOUL','SKILLS','RULES','CONTEXT')),
      content TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (client_id, fragment)
    )`;

    await this.ctx.storage.put("_db_initialized", "1");
  }

  async onConnect(_connection: Connection, _ctx: ConnectionContext) {
    // Ensure DB is initialized (once per DO instance)
    const initialized = await this.ctx.storage.get("_db_initialized");
    if (!initialized) await this.initDb();

    // Create a new conversation row
    const conversationId = crypto.randomUUID();
    const clientId = this.env.CLIENT_ID || "tp3studio";
    this.sql`INSERT INTO conversations (id, client_id) VALUES (${conversationId}, ${clientId})`;
    await this.ctx.storage.put(`conv:${_connection.id}`, conversationId);
  }

  async onMessage(connection: Connection, message: string) {
    try {
      const data = JSON.parse(message);
      if (data.type !== "chat" || !data.message) return;

      const clientId = this.env.CLIENT_ID || "tp3studio";
      const today = new Date().toISOString().slice(0, 10);

      // Resolve or create conversation
      let conversationId = await this.ctx.storage.get(`conv:${connection.id}`) as string | null;
      if (!conversationId) {
        conversationId = crypto.randomUUID();
        this.sql`INSERT INTO conversations (id, client_id) VALUES (${conversationId}, ${clientId})`;
        await this.ctx.storage.put(`conv:${connection.id}`, conversationId);
      }

      // Record user message
      this.sql`INSERT INTO messages (conversation_id, role, content) VALUES (${conversationId}, 'user', ${data.message})`;
      this.sql`UPDATE conversations SET message_count = message_count + 1, updated_at = datetime('now'), last_message = ${data.message.slice(0, 200)} WHERE id = ${conversationId}`;
      // Increment daily counter
      this.sql`INSERT INTO daily_metrics (date, client_id, messages, tool_calls, tool_errors) VALUES (${today}, ${clientId}, 1, 0, 0) ON CONFLICT (date, client_id) DO UPDATE SET messages = messages + 1`;

      const history = (data.history || []).slice(-20).map((m: any) => ({
        role: m.role === "bot" ? "assistant" : m.role,
        content: m.content,
      }));
      history.push({ role: "user", content: data.message });

      const systemPrompt = getSystemPrompt(clientId, this.sql as any);
      const toolsUrl = this.env.TOOLS_URL;
      const tools = getTools(toolsUrl);

      // Tool callback that records metrics
      const toolCallback = toolsUrl
        ? async (name: string, args: Record<string, any>) => {
            const start = Date.now();
            try {
              const result = await executeToolCall(name, args, toolsUrl);
              const duration = Date.now() - start;
              const isError = result.includes('"error"');
              this.sql`INSERT INTO tool_calls (conversation_id, name, args, success, error_message, duration_ms) VALUES (${conversationId}, ${name}, ${JSON.stringify(args)}, ${isError ? 0 : 1}, ${isError ? result.slice(0, 200) : null}, ${duration})`;
              this.sql`INSERT INTO daily_metrics (date, client_id, messages, tool_calls, tool_errors) VALUES (${today}, ${clientId}, 0, 1, ${isError ? 1 : 0}) ON CONFLICT (date, client_id) DO UPDATE SET tool_calls = tool_calls + 1, tool_errors = tool_errors + ${isError ? 1 : 0}`;
              return result;
            } catch (err: any) {
              const duration = Date.now() - start;
              this.sql`INSERT INTO tool_calls (conversation_id, name, args, success, error_message, duration_ms) VALUES (${conversationId}, ${name}, ${JSON.stringify(args)}, 0, ${err.message || "Unknown error"}, ${duration})`;
              this.sql`INSERT INTO daily_metrics (date, client_id, messages, tool_calls, tool_errors) VALUES (${today}, ${clientId}, 0, 1, 1) ON CONFLICT (date, client_id) DO UPDATE SET tool_calls = tool_calls + 1, tool_errors = tool_errors + 1`;
              return JSON.stringify({ error: err.message || "Tool execution failed" });
            }
          }
        : undefined;

      const reply = await streamDeepSeek(
        this.env.AI_GATEWAY_TOKEN,
        clientId,
        systemPrompt,
        history,
        (delta) => {
          connection.send(
            JSON.stringify({ type: "chat-chunk", text: delta, done: false }),
          );
        },
        (fullText) => {
          // Record assistant message
          this.sql`INSERT INTO messages (conversation_id, role, content) VALUES (${conversationId}, 'assistant', ${fullText})`;
          this.sql`UPDATE conversations SET updated_at = datetime('now'), last_message = ${fullText.slice(0, 200)} WHERE id = ${conversationId}`;
          connection.send(
            JSON.stringify({ type: "chat-chunk", full: fullText, done: true }),
          );
        },
        tools,
        toolCallback,
      );

      if (reply === null) {
        connection.send(
          JSON.stringify({
            type: "chat-response",
            message: "Lo siento, tuve un problema. Intenta de nuevo.",
          }),
        );
      }
    } catch {
      connection.send(
        JSON.stringify({ type: "chat-response", message: "Ocurrió un error." }),
      );
    }
  }

  // ─── Admin RPC methods (called from fetch handler via DO stub) ───

  /** Ensure DB tables exist before running admin queries */
  async ensureDb() {
    const initialized = await this.ctx.storage.get("_db_initialized");
    if (!initialized) await this.initDb();
  }

  async adminGetStats(clientId: string) {
    await this.ensureDb();
    const today = new Date().toISOString().slice(0, 10);
    const todayRows = this.sql`SELECT messages, tool_calls, tool_errors FROM daily_metrics WHERE date = ${today} AND client_id = ${clientId}` as any[];
    const seriesRows = this.sql`SELECT date, messages, tool_calls, tool_errors FROM daily_metrics WHERE client_id = ${clientId} ORDER BY date DESC LIMIT 30` as any[];
    return {
      today: todayRows[0] || { messages: 0, tool_calls: 0, tool_errors: 0 },
      series: seriesRows,
      connections: [...this.getConnections()].length,
    };
  }

  async adminGetConversations(limit: number, offset: number) {
    await this.ensureDb();
    const rows = this.sql`SELECT id, client_id, created_at, updated_at, message_count, last_message FROM conversations ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}` as any[];
    return { conversations: rows };
  }

  async adminGetConversation(conversationId: string) {
    await this.ensureDb();
    const rows = this.sql`SELECT role, content, created_at FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at ASC` as any[];
    return { messages: rows };
  }

  async adminGetPrompts(clientId: string) {
    await this.ensureDb();
    const rows = this.sql`SELECT fragment, content FROM runtime_prompts WHERE client_id = ${clientId}` as any[];
    const defaults = DEFAULTS[clientId] ?? DEFAULTS["tp3studio"];
    const fragments = ["SOUL", "SKILLS", "RULES", "CONTEXT"];
    const overrides: Record<string, string> = {};
    for (const r of rows) {
      if (r.content && r.content.trim()) {
        overrides[r.fragment] = r.content;
      }
    }
    return {
      prompts: fragments.map((f) => ({
        fragment: f,
        content: overrides[f] !== undefined ? overrides[f] : (defaults[f] || ""),
        hasOverride: overrides[f] !== undefined,
      })),
    };
  }

  async adminSavePrompt(clientId: string, fragment: string, content: string) {
    await this.ensureDb();
    if (!content || !content.trim()) {
      // Empty content = reset to compiled default
      this.sql`DELETE FROM runtime_prompts WHERE client_id = ${clientId} AND fragment = ${fragment}`;
    } else {
      this.sql`INSERT INTO runtime_prompts (client_id, fragment, content, updated_at) VALUES (${clientId}, ${fragment}, ${content}, datetime('now')) ON CONFLICT (client_id, fragment) DO UPDATE SET content = ${content}, updated_at = datetime('now')`;
    }
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return handleCors();

    // ── Admin dashboard routes ──
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return new Response(overviewPage(), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
      });
    }
    if (url.pathname === "/admin/conversations") {
      return new Response(conversationsPage(), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
      });
    }
    if (url.pathname === "/admin/prompts") {
      return new Response(promptsPage(env.CLIENT_ID || "tp3studio"), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
      });
    }

    // ── Admin API routes ──
    if (url.pathname === "/admin/api/stats") {
      return handleStats(env, url);
    }
    if (url.pathname === "/admin/api/conversations") {
      return handleConversations(env, url);
    }
    if (url.pathname.startsWith("/admin/api/conversations/")) {
      const id = url.pathname.slice("/admin/api/conversations/".length);
      if (!id) return new Response("Missing conversation id", { status: 400, headers: corsHeaders });
      return handleConversation(env, id);
    }
    if (url.pathname === "/admin/api/prompts") {
      if (request.method === "POST") {
        return handleSavePrompt(env, request);
      }
      return handleGetPrompts(env, url);
    }

    // ── Existing routes ──
    if (url.pathname === "/health")
      return Response.json(
        { status: "ok", agent: "tp3studio-chat" },
        { headers: corsHeaders },
      );
    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const body: any = await request.json();
        const messages = (body.messages || []).slice(-20);

        const clientId = env.CLIENT_ID || "tp3studio";
        const systemPrompt = getSystemPrompt(clientId);
        const toolsUrl = env.TOOLS_URL;
        const tools = getTools(toolsUrl);

        // Use non-streaming with tools for HTTP fallback
        const result = await fetch(AI_GATEWAY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.AI_GATEWAY_TOKEN}`,
            "cf-aig-metadata": `{"client":"${clientId}"}`,
          },
          body: JSON.stringify({
            model: "deepseek/deepseek-chat",
            messages: [{ role: "system", content: systemPrompt }, ...messages],
            max_tokens: tools && tools.length > 0 ? 2048 : 1024,
            temperature: 0.7,
            stream: false,
            ...(tools && tools.length > 0 ? { tools } : {}),
          }),
          signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
        });

        if (!result.ok)
          return Response.json(
            { reply: "Error del asistente." },
            { status: 500, headers: corsHeaders },
          );

        const completion: any = await result.json();
        const msg = completion.choices?.[0]?.message;

        // Handle tool calls in HTTP fallback
        if (msg?.tool_calls && toolsUrl) {
          const toolResults: any[] = [];
          for (const tc of msg.tool_calls) {
            const args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
            const toolResult = await executeToolCall(tc.function.name, args, toolsUrl);
            toolResults.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          }

          const secondResult = await fetch(AI_GATEWAY_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.AI_GATEWAY_TOKEN}`,
              "cf-aig-metadata": `{"client":"${clientId}"}`,
            },
            body: JSON.stringify({
              model: "deepseek/deepseek-chat",
              messages: [
                { role: "system", content: systemPrompt },
                ...messages,
                { role: "assistant", content: null, tool_calls: msg.tool_calls },
                ...toolResults,
              ],
              max_tokens: 2048,
              temperature: 0.7,
              stream: false,
            }),
            signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
          });

          if (!secondResult.ok)
            return Response.json(
              { reply: "Error del asistente." },
              { status: 500, headers: corsHeaders },
            );

          const second: any = await secondResult.json();
          const reply2 = second.choices?.[0]?.message?.content;
          return Response.json({ reply: reply2 || "Sin respuesta." }, { headers: corsHeaders });
        }

        const reply = msg?.content;
        if (!reply)
          return Response.json(
            { reply: "Error del asistente." },
            { status: 500, headers: corsHeaders },
          );
        return Response.json({ reply }, { headers: corsHeaders });
      } catch {
        return Response.json(
          { reply: "Error al procesar el mensaje." },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // Rewrite agent URLs to use a fixed DO instance name ("chat")
    // so the admin dashboard and all WebSocket sessions share one DO.
    // The widget appends a random session ID to the URL —
    // we ignore it and route everything to the same DO.
    if (url.pathname.startsWith("/agents/")) {
      const parts = url.pathname.split("/");
      // parts: ["", "agents", "Tp3ChatAgent" or kebab-case, randomSessionId]
      if (parts.length >= 4 && parts[3] !== "chat") {
        parts[3] = "chat";
        const newUrl = new URL(request.url);
        newUrl.pathname = parts.join("/");
        request = new Request(newUrl.toString(), request);
      }
    }

    const resp = await routeAgentRequest(request, env);
    if (resp) {
      const newResp = new Response(resp.body, resp);
      for (const [k, v] of Object.entries(corsHeaders))
        newResp.headers.set(k, v);
      return newResp;
    }
    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

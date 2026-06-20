/// <reference types="@cloudflare/workers-types" />

import { Think } from "@cloudflare/think";
import { createOpenAI } from "@ai-sdk/openai";
import { routeAgentRequest } from "agents";
import { getSystemPrompt, DEFAULTS } from "./prompts";
import { buildTools } from "./tools";
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
  AI: Ai;
  AI_GATEWAY_TOKEN: string;
  CLIENT_ID: string;
  TOOLS_URL?: string;
  Tp3ChatAgent: DurableObjectNamespace;
}

const DEEPSEEK_MODEL = "deepseek/deepseek-chat";

export class Tp3ChatAgent extends Think<Env> {
  workspaceBash = false;

  /** Only expose our custom API tools — block workspace, MCP, browser */
  beforeTurn(_ctx: any) {
    return { activeTools: ["get_collections", "query_collection"] };
  }

  getModel() {
    const provider = createOpenAI({
      baseURL: "https://gateway.ai.cloudflare.com/v1/e3e57fcc48f7a3905b335a21ff5de958/tp3-gateway/compat",
      apiKey: this.env.AI_GATEWAY_TOKEN,
      headers: {
        "cf-aig-metadata": `{"client":"${this.env.CLIENT_ID || "tp3studio"}"}`,
      },
    });
    // Use .chat() — Chat Completions API compatible with AI Gateway /compat
    // .responses() (the default) uses Responses API which the Gateway doesn't support
    return provider.chat(DEEPSEEK_MODEL as any);
  }

  getSystemPrompt(): string {
    return getSystemPrompt(this.env.CLIENT_ID || "tp3studio", this.sql);
  }

  /** Sync runtime prompt overrides from the shared dashboard DO on session start. */
  async configureSession(session: any) {
    const configured = await super.configureSession?.(session) || session;
    try {
      // Ensure the local table exists (first connection creates it)
      this.sql`CREATE TABLE IF NOT EXISTS runtime_prompts (
        client_id TEXT NOT NULL, fragment TEXT NOT NULL CHECK(fragment IN ('SOUL','SKILLS','RULES','CONTEXT')),
        content TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (client_id, fragment)
      )`;
      // Fetch overrides from the shared "chat" DO and mirror locally
      const ns = this.env.Tp3ChatAgent;
      const dashStub = ns.get(ns.idFromName("chat"));
      const result = await (dashStub as any).adminGetPrompts(this.env.CLIENT_ID || "tp3studio");
      if (result?.prompts) {
        for (const p of result.prompts) {
          if (p.hasOverride) {
            this.sql`INSERT INTO runtime_prompts (client_id, fragment, content, updated_at)
              VALUES (${this.env.CLIENT_ID || "tp3studio"}, ${p.fragment}, ${p.content}, datetime('now'))
              ON CONFLICT (client_id, fragment) DO UPDATE SET content = ${p.content}, updated_at = datetime('now')`;
          }
        }
      }
    } catch {} // dashboard DO may not exist yet — use compiled defaults
    return configured;
  }

  getTools() {
    return buildTools(this.env.TOOLS_URL);
  }

  async onConnect(connection: any, ctx: any) {
    try {
      this.sql`CREATE TABLE IF NOT EXISTS _debug_conn (ts TEXT DEFAULT (datetime('now')), id TEXT)`;
      this.sql`INSERT INTO _debug_conn (id) VALUES (${connection?.id || "no-id"})`;
    } catch {}
    return super.onConnect?.(connection, ctx);
  }

  // ─── Dashboard admin RPC methods ───

  async adminGetConnections() { return [...this.getConnections()].length; }
  async adminGetConversation(conversationId: string) { return { messages: this.sql`SELECT role, content, created_at FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at ASC` as any[] }; }
  async adminGetConversations(limit: number, offset: number) { return { conversations: this.sql`SELECT id, client_id, created_at, updated_at, message_count, last_message FROM conversations ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}` as any[] }; }
  async adminGetStats(clientId: string) { const t = new Date().toISOString().slice(0, 10); const row = (this.sql`SELECT messages, tool_calls, tool_errors FROM daily_metrics WHERE date = ${t} AND client_id = ${clientId}` as any[])[0]; return { today: row || { messages: 0, tool_calls: 0, tool_errors: 0 }, series: this.sql`SELECT date, messages, tool_calls, tool_errors FROM daily_metrics WHERE client_id = ${clientId} ORDER BY date DESC LIMIT 30` as any[], connections: [...this.getConnections()].length }; }
  async adminGetPrompts(clientId: string) { const rows = this.sql`SELECT fragment, content FROM runtime_prompts WHERE client_id = ${clientId}` as any[]; const defaults = DEFAULTS[clientId] ?? DEFAULTS["tp3studio"]; const fragments = ["SOUL", "SKILLS", "RULES", "CONTEXT"]; const ov: Record<string, string> = {}; for (const r of rows) { if (r.content?.trim()) ov[r.fragment] = r.content; } return { prompts: fragments.map((f) => ({ fragment: f, content: ov[f] !== undefined ? ov[f] : (defaults[f] || ""), hasOverride: ov[f] !== undefined })) }; }
  async adminSavePrompt(clientId: string, fragment: string, content: string) { if (!content?.trim()) { this.sql`DELETE FROM runtime_prompts WHERE client_id = ${clientId} AND fragment = ${fragment}`; } else { this.sql`INSERT INTO runtime_prompts (client_id, fragment, content, updated_at) VALUES (${clientId}, ${fragment}, ${content}, datetime('now')) ON CONFLICT (client_id, fragment) DO UPDATE SET content = ${content}, updated_at = datetime('now')`; } }
  async adminDebugConns() { return this.sql`SELECT * FROM _debug_conn ORDER BY ts DESC LIMIT 10` as any[]; }

}

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleCors();
    if (url.pathname === "/admin" || url.pathname === "/admin/") return new Response(overviewPage(), { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
    if (url.pathname === "/admin/conversations") return new Response(conversationsPage(), { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
    if (url.pathname === "/admin/prompts") return new Response(promptsPage(env.CLIENT_ID || "tp3studio"), { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
    if (url.pathname === "/admin/api/stats") return handleStats(env, url);
    if (url.pathname === "/admin/api/conversations") return handleConversations(env, url);
    if (url.pathname.startsWith("/admin/api/conversations/")) { const id = url.pathname.slice("/admin/api/conversations/".length); if (!id) return new Response("Missing id", { status: 400, headers: corsHeaders }); return handleConversation(env, id); }
    if (url.pathname === "/admin/api/prompts") { if (request.method === "POST") return handleSavePrompt(env, request); return handleGetPrompts(env, url); }
    if (url.pathname === "/health") return Response.json({
      status: "ok",
      model: DEEPSEEK_MODEL,
      hasGatewayToken: !!env.AI_GATEWAY_TOKEN,
      hasToolsUrl: !!env.TOOLS_URL,
    }, { headers: corsHeaders });
    if (url.pathname === "/test-openai") {
      const provider = createOpenAI({
        baseURL: "https://gateway.ai.cloudflare.com/v1/e3e57fcc48f7a3905b335a21ff5de958/tp3-gateway/compat",
        apiKey: env.AI_GATEWAY_TOKEN,
      });
      try {
        const { generateText } = await import("ai");
        const result = await generateText({
          model: provider.chat("deepseek/deepseek-chat"),
          messages: [{ role: "user", content: "Di hola" }],
        });
        return Response.json({ ok: true, text: result.text }, { headers: corsHeaders });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message, stack: e.stack }, { status: 500, headers: corsHeaders });
      }
    }
    if (url.pathname === "/test-stream") {
      const stream = await env.AI.run(DEEPSEEK_MODEL, {
        messages: [{ role: "user", content: "Di hola en una palabra" }],
        stream: true,
      }, { gateway: { id: "tp3-gateway" } });
      let text = "";
      for await (const chunk of stream as any) {
        text += chunk?.choices?.[0]?.delta?.content || chunk?.response || "";
      }
      return Response.json({ streamed: text || "empty" }, { headers: corsHeaders });
    }
    if (url.pathname === "/debug-conns") {
      const instance = url.searchParams.get("instance") || "default";
      const ns = env.Tp3ChatAgent;
      const stub = ns.get(ns.idFromName(instance));
      try {
        const rows = await (stub as any).adminDebugConns();
        return Response.json({ instance, rows }, { headers: corsHeaders });
      } catch (e: any) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }
    if (url.pathname === "/conns") {
      const instance = url.searchParams.get("instance") || "default";
      const ns = env.Tp3ChatAgent;
      const stub = ns.get(ns.idFromName(instance));
      const count = await (stub as any).adminGetConnections();
      return Response.json({ instance, count }, { headers: corsHeaders });
    }

    try {
      const resp = await routeAgentRequest(request, env, { cors: true });
      if (resp) return resp; // NEVER wrap a WebSocket upgrade response
      return new Response("Not found", { status: 404, headers: corsHeaders });
    } catch (err: any) {
      console.error("routeAgentRequest failed:", err);
      return new Response("Internal error", { status: 500, headers: corsHeaders });
    }
  },
};

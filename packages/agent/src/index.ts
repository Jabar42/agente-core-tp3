/// <reference types="@cloudflare/workers-types" />

import {
  Agent,
  routeAgentRequest,
  type Connection,
  type ConnectionContext,
} from "agents";
import { getSystemPrompt } from "./prompts";

interface Env {
  DEEPSEEK_API_KEY: string;
  CLIENT_ID: string;
  MCP_URL?: string;
  Tp3ChatAgent: DurableObjectNamespace;
}

const DEEPSEEK_TIMEOUT_MS = 25000;

/**
 * Non-streaming call to DeepSeek. Used by the HTTP /api/chat fallback.
 */
async function chatWithDeepSeek(
  apiKey: string,
  systemPrompt: string,
  messages: { role: string; content: string }[],
): Promise<string | null> {
  try {
    const response = await fetch(
      "https://api.deepseek.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.slice(-20),
          ],
          max_tokens: 1024,
          temperature: 0.7,
          stream: false,
        }),
        signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
      },
    );
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
  apiKey: string,
  systemPrompt: string,
  messages: { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string }[],
  onToken: (delta: string) => void,
  onDone: (fullText: string) => void,
  tools?: any[],
  onToolCall?: (name: string, args: Record<string, any>) => Promise<string>,
): Promise<string | null> {
  try {
    const body: any = {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.slice(-20),
      ],
      max_tokens: tools && tools.length > 0 ? 2048 : 1024,
      temperature: 0.7,
      stream: true,
    };
    if (tools && tools.length > 0) body.tools = tools;

    const response = await fetch(
      "https://api.deepseek.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
      },
    );

    if (!response.ok || !response.body) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";
    // Accumulate tool call deltas by index
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

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

          // Normal content delta
          if (delta.content && toolCalls.size === 0) {
            fullText += delta.content;
            onToken(delta.content);
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
        apiKey, systemPrompt, newMessages,
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
  async onConnect(_connection: Connection, _ctx: ConnectionContext) {
    // Connection established. The widget shows its own welcome message,
    // so we just wait for the first user message via onMessage().
  }

  async onMessage(connection: Connection, message: string) {
    try {
      const data = JSON.parse(message);
      if (data.type !== "chat" || !data.message) return;

      const history = (data.history || []).slice(-20).map((m: any) => ({
        role: m.role === "bot" ? "assistant" : m.role,
        content: m.content,
      }));
      history.push({ role: "user", content: data.message });

      const clientId = this.env.CLIENT_ID || "tp3studio";
      const systemPrompt = getSystemPrompt(clientId);
      const mcpUrl = this.env.MCP_URL;

      // MCP: discover tools from the MCP server
      let tools: any[] | undefined;
      let onToolCall: ((name: string, args: Record<string, any>) => Promise<string>) | undefined;

      if (mcpUrl) {
        try {
          await this.addMcpServer(clientId, mcpUrl);
          const mcpTools = this.listTools();
          if (mcpTools.length > 0) {
            tools = mcpTools.map((t: any) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            }));
            onToolCall = async (name: string, args: Record<string, any>) => {
              const result = await this.callTool({ name, arguments: args, serverId: clientId }) as any;
              if (Array.isArray(result?.content)) {
                return result.content.map((c: any) => c.text || "").join("\n");
              }
              return JSON.stringify(result);
            };
          }
        } catch (err: any) {
          console.error("MCP error:", err.message);
        }
      }

      const reply = await streamDeepSeek(
        this.env.DEEPSEEK_API_KEY,
        systemPrompt,
        history,
        (delta) => {
          connection.send(
            JSON.stringify({ type: "chat-chunk", text: delta, done: false }),
          );
        },
        (fullText) => {
          connection.send(
            JSON.stringify({ type: "chat-chunk", full: fullText, done: true }),
          );
        },
        tools,
        onToolCall,
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
        JSON.stringify({ type: "chat-response", message: "Ocurrio un error." }),
      );
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
      return new Response(null, { headers: corsHeaders });
    if (url.pathname === "/health")
      return Response.json(
        { status: "ok", agent: "tp3studio-chat" },
        { headers: corsHeaders },
      );
    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const body: any = await request.json();
        const messages = (body.messages || []).slice(-20);
        const apiKey = env.DEEPSEEK_API_KEY;
        if (!apiKey)
          return Response.json(
            { reply: "Error de configuración." },
            { status: 500, headers: corsHeaders },
          );

        const clientId = env.CLIENT_ID || "tp3studio";
        const systemPrompt = getSystemPrompt(clientId);
        // HTTP fallback: use direct REST API (no MCP SDK in fetch handler)
        const mcpUrl = env.MCP_URL;
        const apiBase = mcpUrl ? mcpUrl.replace("varsana-mcp", "varsana-co") : undefined;
        const tools = apiBase ? [{
          type: "function" as const,
          function: {
            name: "get_collection",
            description: "Consulta eventos, pasadias o nosotros. Parametros: collection (events|pasadias|nosotros), slug (opcional).",
            parameters: {
              type: "object",
              properties: {
                collection: { type: "string", enum: ["events", "pasadias", "nosotros"] },
                slug: { type: "string" },
              },
              required: ["collection"],
            },
          },
        }] : undefined;

        // Use non-streaming with tools for HTTP fallback
        const result = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "deepseek-chat",
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
        if (msg?.tool_calls && apiBase) {
          const toolResults: any[] = [];
          for (const tc of msg.tool_calls) {
            const args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
            const col = args.collection || "events";
            const slug = args.slug ? "?slug=" + encodeURIComponent(args.slug) : "";
            const url = apiBase + "/api/" + col + slug;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            const toolResult = res.ok ? await res.text() : JSON.stringify({ error: "API status " + res.status });
            toolResults.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          }

          const secondResult = await fetch("https://api.deepseek.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: "deepseek-chat",
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

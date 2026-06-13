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
  messages: { role: string; content: string }[],
  onToken: (delta: string) => void,
  onDone: (fullText: string) => void,
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
          stream: true,
        }),
        signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
      },
    );

    if (!response.ok || !response.body) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onToken(delta);
          }
        } catch {
          // Skip unparseable lines
        }
      }
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

      const reply = await streamDeepSeek(
        this.env.DEEPSEEK_API_KEY,
        systemPrompt,
        history,
        // onToken: send each chunk immediately
        (delta) => {
          connection.send(
            JSON.stringify({ type: "chat-chunk", text: delta, done: false }),
          );
        },
        // onDone: send final chunk with full text
        (fullText) => {
          connection.send(
            JSON.stringify({ type: "chat-chunk", full: fullText, done: true }),
          );
        },
      );

      // Fallback if streaming failed entirely
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

        const reply = await chatWithDeepSeek(apiKey, systemPrompt, messages);
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

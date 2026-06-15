import { useState, useRef, useEffect, useCallback } from "react";

export interface ChatWidgetProps {
  /** Worker host, e.g. "tp3studio-chat.iaforchange.workers.dev" */
  agentHost: string;
  /** Agent name (DO binding in kebab-case), default: "tp3-chat-agent" */
  agentName?: string;
  /** Brand name shown in the header, default: "Tp3studio" */
  brandName?: string;
  /** Subtitle shown below the brand name, default: "Asistente virtual" */
  brandSubtitle?: string;
  /** Welcome message shown on first open */
  welcomeMessage?: string;
}

interface Message {
  id: string;
  role: "user" | "bot" | "error";
  text: string;
}

/**
 * Minimal markdown → HTML for LLM-generated text.
 * Escapes HTML first (safe), then applies formatting rules.
 */
function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");

  // FIX #7: Validate URL scheme before rendering links to prevent javascript: injection
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, href: string) => {
      const safe = /^https?:\/\//i.test(href);
      return safe
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    },
  );

  html = html.replace(/^#{1,4}\s+(.+)$/gm, "<strong>$1</strong>");
  html = html.replace(/^[\t ]*[-*]\s+(.+)$/gm, "• $1");
  html = html.replace(/\n\n/g, "<br><br>");
  html = html.replace(/\n/g, "<br>");

  return html;
}

const DEFAULTS = {
  agentName: "tp3-chat-agent",
  brandName: "Tp3studio",
  brandSubtitle: "Asistente virtual",
  welcomeMessage:
    "👋 ¡Hola! Soy el asistente de Tp3studio. ¿En qué puedo ayudarte?",
} as const;

// FIX #10: Reduced typewriter delay for a snappier feel
const TYPEWRITER_MS = 100;
// FIX #6: Max retries for the send loop
const MAX_SEND_RETRIES = 15;

function makeId(): string {
  return crypto.randomUUID();
}

export default function ChatWidget({
  agentHost,
  agentName = DEFAULTS.agentName,
  brandName = DEFAULTS.brandName,
  brandSubtitle = DEFAULTS.brandSubtitle,
  welcomeMessage = DEFAULTS.welcomeMessage,
}: ChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [input, setInput] = useState("");
  // FIX #8: Messages use a stable unique id instead of array index
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typewriterQueue = useRef<string[]>([]);
  const typewriterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamDone = useRef(false);
  // FIX #1: Keep a live ref to messages so closures always read current state
  const messagesRef = useRef<Message[]>([]);
  // FIX #12: Track first render to avoid blocking scroll on first bot message
  const isFirstRender = useRef(true);

  // Keep messagesRef in sync with state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!loading && open) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [loading, open]);

  // FIX #4 & #5: Clean up interval and WebSocket on unmount
  useEffect(() => {
    return () => {
      if (typewriterTimer.current) {
        clearInterval(typewriterTimer.current);
      }
      wsRef.current?.close();
    };
  }, []);

  function stopTypewriter() {
    if (typewriterTimer.current) {
      clearInterval(typewriterTimer.current);
      typewriterTimer.current = null;
    }
  }

  function startTypewriter(botMsgId: string) {
    let fullText = "";

    typewriterTimer.current = setInterval(() => {
      const queue = typewriterQueue.current;

      if (queue.length > 0) {
        // Drain up to 3 chunks per tick to keep up with fast streams
        const chunk = queue.splice(0, 3).join("");
        fullText += chunk;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === botMsgId ? { ...m, text: fullText } : m,
          ),
        );
        return;
      }

      if (streamDone.current) {
        stopTypewriter();
        setLoading(false);
      }
    }, TYPEWRITER_MS);
  }

  // FIX #2 & #3: connectWs properly closes any existing socket before opening a new one
  const connectWs = useCallback(() => {
    // Close any socket that is open or still connecting
    if (
      wsRef.current &&
      wsRef.current.readyState !== WebSocket.CLOSED &&
      wsRef.current.readyState !== WebSocket.CLOSING
    ) {
      wsRef.current.onclose = null; // prevent the onclose handler from running
      wsRef.current.close();
      wsRef.current = null;
    }

    typewriterQueue.current = [];
    streamDone.current = false;
    stopTypewriter();

    const sid = crypto.randomUUID().slice(0, 8);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${agentHost}/agents/${agentName}/${sid}`,
    );
    wsRef.current = ws;

    ws.onopen = () => {
      if (messagesRef.current.length === 0) {
        const welcomeMsg: Message = {
          id: makeId(),
          role: "bot",
          text: welcomeMessage,
        };
        setMessages([welcomeMsg]);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as {
          type: string;
          message?: string;
          text?: string;
          done?: boolean;
        };

        if (data.type === "chat-response") {
          streamDone.current = true;
          stopTypewriter();
          setMessages((prev) => [
            ...prev,
            { id: makeId(), role: "bot", text: data.message ?? "" },
          ]);
          setLoading(false);
        } else if (data.type === "chat-chunk") {
          if (!data.done) {
            if (!typewriterTimer.current) {
              const botMsgId = makeId();
              // Add a placeholder message that the typewriter will fill
              setMessages((prev) => [
                ...prev,
                { id: botMsgId, role: "bot", text: "" },
              ]);
              startTypewriter(botMsgId);
            }
            typewriterQueue.current.push(data.text ?? "");
          } else {
            streamDone.current = true;
          }
        }
      } catch {
        // Ignore malformed frames
      }
    };

    ws.onerror = () => {
      streamDone.current = true;
      stopTypewriter();
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "error",
          text: "⚠ Error al conectar con el asistente.",
        },
      ]);
      setLoading(false);
    };

    ws.onclose = () => {
      streamDone.current = true;
      stopTypewriter();
      wsRef.current = null;
    };
  }, [agentHost, agentName, welcomeMessage]);

  function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");

    const userMsg: Message = { id: makeId(), role: "user", text };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    // Reconnect automatically if the socket dropped between messages
    const state = wsRef.current?.readyState;
    if (state === undefined || state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
      connectWs();
    }

    let retries = 0;
    const trySend = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const history = messagesRef.current
          .filter((m) => m.role !== "error")
          .slice(-20)
          .map((m) => ({
            role: m.role === "bot" ? "assistant" : "user",
            content: m.text,
          }));
        // Include the new user message which may not be in ref yet
        history.push({ role: "user", content: text });

        wsRef.current.send(
          JSON.stringify({ type: "chat", message: text, history }),
        );
      } else if (retries < MAX_SEND_RETRIES) {
        retries++;
        setTimeout(trySend, 200);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            role: "error",
            text: "⚠ No se pudo conectar con el asistente. Intenta de nuevo.",
          },
        ]);
        setLoading(false);
      }
    };
    trySend();
  }

  const chatWidth = 380;
  const chatHeight = 540;

  return (
    <>
      <style>{`
        @keyframes slide-up { from { opacity:0; transform:translateY(16px) scale(0.96); } to { opacity:1; transform:translateY(0) scale(1); } }
        @keyframes slide-down { from { opacity:1; transform:translateY(0) scale(1); } to { opacity:0; transform:translateY(16px) scale(0.96); } }
        .chat-window { animation:slide-up .35s cubic-bezier(.16,1,.3,1) forwards; }
        .chat-window-out { animation:slide-down .25s ease-in forwards; }
        @keyframes typing-dot { 0%,60% { opacity:.2; transform:translateY(0); } 30% { opacity:1; transform:translateY(-6px); } 100% { opacity:.2; transform:translateY(0); } }
        .typing-indicator { display:flex; align-items:center; gap:4px; padding:8px 14px; }
        .typing-indicator span { width:7px; height:7px; border-radius:50%; background:var(--chat-primary, #6366F1); animation:typing-dot 1.4s infinite ease-in-out; }
        .typing-indicator span:nth-child(2) { animation-delay:.15s; }
        .typing-indicator span:nth-child(3) { animation-delay:.3s; }
        .bot-msg a { color:var(--chat-primary, #6366F1); text-decoration:underline; }
        .bot-msg a:hover { color:var(--chat-primary-hover, #4F46E5); }
        .bot-msg code { background:var(--chat-code-bg, rgba(99,102,241,.12)); color:var(--chat-primary, #6366F1); padding:1px 5px; border-radius:4px; font-size:.9em; font-family:monospace; }
        .bot-msg strong { font-weight:600; color:var(--chat-bot-text, #18181B); }
        .bot-msg em { font-style:italic; }
        @media (max-width: 480px) {
          .chat-window, .chat-window-out {
            width: 100% !important; height: 100% !important;
            max-width: 100% !important; max-height: 100% !important;
            bottom: 0 !important; right: 0 !important;
            border-radius: 0 !important;
          }
        }
      `}</style>

      {!open && (
        <button
          onClick={() => {
            connectWs();
            setOpen(true);
          }}
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 9999,
            width: 56,
            height: 56,
            borderRadius: 16,
            background: "var(--chat-primary, #6366F1)",
            color: "var(--chat-primary-fg, #fff)",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            boxShadow: "var(--chat-shadow, 0 8px 24px rgba(0,0,0,.12))",
          }}
          aria-label="Abrir chat"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}

      {open && (
        <div
          className={closing ? "chat-window-out" : "chat-window"}
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 9998,
            width: chatWidth,
            maxWidth: "calc(100vw - 48px)",
            height: chatHeight,
            maxHeight: "calc(100dvh - 48px)",
            background: "var(--chat-primary-fg, #fff)",
            display: "flex",
            flexDirection: "column",
            borderRadius: 16,
            boxShadow: "var(--chat-shadow-lg, 0 12px 48px rgba(0,0,0,.18))",
            touchAction: "none",
          }}
          ref={(el) => {
            if (!el) return;
            el.onwheel = (e) => {
              const target = e.target as HTMLElement;
              if (!target.closest("[data-chat-messages]")) {
                e.preventDefault();
              }
            };
          }}
        >
          {/* Header */}
          <div
            style={{
              background: "var(--chat-primary, #6366F1)",
              color: "var(--chat-primary-fg, #fff)",
              padding: "14px 20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexShrink: 0,
              borderRadius: "16px 16px 0 0",
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: "var(--chat-font-heading, 'Outfit', sans-serif)",
                  fontWeight: 600,
                  fontSize: 16,
                }}
              >
                {brandName}
              </div>
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 1 }}>
                {brandSubtitle}
              </div>
            </div>
            <button
              onClick={() => {
                wsRef.current?.close();
                setClosing(true);
                setTimeout(() => {
                  setOpen(false);
                  setClosing(false);
                }, 250);
              }}
              style={{
                width: 32,
                height: 32,
                borderRadius: 12,
                background: "var(--chat-close-btn-bg, rgba(255,255,255,.1))",
                border: "none",
                color: "var(--chat-primary-fg, #fff)",
                cursor: "pointer",
              }}
              aria-label="Cerrar chat"
            >
              ✕
            </button>
          </div>

          {/* Messages */}
          <div
            data-chat-messages
            style={{
              flex: 1,
              overflowY: "auto",
              overscrollBehavior: "contain",
              touchAction: "pan-y",
              padding: "12px 16px",
              display: "flex",
              flexDirection: "column",
              // FIX scroll: NO justifyContent flex-end — it breaks overflow scrolling.
              // The spacer div below pushes messages to the bottom when there are few of them.
              gap: 10,
              fontFamily: "var(--chat-font-body, 'Nunito', sans-serif)",
            }}
          >
            {/* Spacer that collapses once messages fill the container */}
            <div style={{ flex: 1, minHeight: 0 }} />
            {/* FIX #8: Use stable message id as key */}
            {messages.map((m) => (
              <div
                key={m.id}
                className={m.role === "bot" ? "bot-msg" : ""}
                style={{
                  maxWidth: "85%",
                  padding: "10px 14px",
                  borderRadius: 16,
                  fontSize: 14,
                  lineHeight: 1.45,
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  background:
                    m.role === "user"
                      ? "var(--chat-primary, #6366F1)"
                      : m.role === "error"
                        ? "var(--chat-error-bubble, #FEE2E2)"
                        : "var(--chat-bot-bubble, #F4F4F5)",
                  color:
                    m.role === "user"
                      ? "var(--chat-primary-fg, #fff)"
                      : m.role === "error"
                        ? "var(--chat-error-text, #991B1B)"
                        : "var(--chat-bot-text, #18181B)",
                  borderBottomRightRadius: m.role === "user" ? 4 : 16,
                  borderBottomLeftRadius: m.role === "user" ? 16 : 4,
                }}
              >
                {m.role === "bot" ? (
                  <span
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(m.text),
                    }}
                  />
                ) : (
                  m.text
                )}
              </div>
            ))}
            {loading && (
              <div
                className="typing-indicator"
                style={{
                  alignSelf: "flex-start",
                  background: "var(--chat-bot-bubble, #F4F4F5)",
                  borderRadius: 16,
                  borderBottomLeftRadius: 4,
                }}
              >
                <span />
                <span />
                <span />
              </div>
            )}
            <div ref={messagesEnd} />
          </div>

          {/* FIX #9: Input area uses div + onKeyDown instead of <form> */}
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: "12px 16px 16px",
              borderTop: "1px solid var(--chat-border, #E4E4E7)",
              flexShrink: 0,
            }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Escribe tu mensaje..."
              disabled={loading}
              style={{
                flex: 1,
                padding: "10px 14px",
                border: "1px solid var(--chat-border, #E4E4E7)",
                borderRadius: 12,
                fontSize: 14,
                outline: "none",
                fontFamily: "var(--chat-font-body, 'Nunito', sans-serif)",
              }}
            />
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                background: "var(--chat-primary, #6366F1)",
                color: "var(--chat-primary-fg, #fff)",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                opacity: loading || !input.trim() ? 0.4 : 1,
              }}
              aria-label="Enviar"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}

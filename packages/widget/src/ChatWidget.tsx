import { useState, useRef, useEffect } from "react";

export interface ChatWidgetProps {
  /** Worker host, e.g. "tp3studio-chat.iaforchange.workers.dev" */
  agentHost: string;
  /** Agent name (DO binding in kebab-case), default: "tp3-chat-agent" */
  agentName?: string;
}

/**
 * Minimal markdown → HTML for LLM-generated text.
 * Escapes HTML first (safe), then applies formatting rules.
 * Covers the 95% case of what DeepSeek / GPT produce.
 */
function renderMarkdown(text: string): string {
  // 1. Escape HTML entities (safety first)
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 2. Inline code: `text` — must run before other rules
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // 3. Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // 4. Italic: *text* (single * not part of list/item)
  html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");

  // 5. Links: [label](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );

  // 6. Headers: ### Text → <strong>Text</strong> (inline header in chat bubble)
  html = html.replace(/^#{1,4}\s+(.+)$/gm, "<strong>$1</strong>");

  // 7. Unordered list items: - or * at line start → bullet
  html = html.replace(/^[\t ]*[-*]\s+(.+)$/gm, "• $1");

  // 8. Double newlines → paragraph break, single newline → <br>
  html = html.replace(/\n\n/g, "<br><br>");
  html = html.replace(/\n/g, "<br>");

  return html;
}

const DEFAULT_AGENT_NAME = "tp3-chat-agent";

export default function ChatWidget({
  agentHost,
  agentName = DEFAULT_AGENT_NAME,
}: ChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<{ role: string; text: string }[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typewriterQueue = useRef<string[]>([]);
  const typewriterTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-focus input when loading completes (response arrived)
  useEffect(() => {
    if (!loading && open) {
      inputRef.current?.focus();
    }
  }, [loading, open]);

  // Typewriter: chunks are queued and released at a steady pace.
  const TYPEWRITER_MS = 180;
  const streamDone = useRef(false);

  function startTypewriter() {
    let fullText = "";

    typewriterTimer.current = setInterval(() => {
      const queue = typewriterQueue.current;

      // Drain one chunk per tick
      if (queue.length > 0) {
        fullText += queue.shift()!;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "bot") {
            next[next.length - 1] = { role: "bot", text: fullText };
          } else {
            next.push({ role: "bot", text: fullText });
          }
          return next;
        });
        return;
      }

      // Queue empty + stream finished → finalize naturally, no burst
      if (streamDone.current) {
        clearInterval(typewriterTimer.current!);
        typewriterTimer.current = null;
        setLoading(false);
      }
    }, TYPEWRITER_MS);
  }

  function connectWs() {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    // Reset state for new connection
    typewriterQueue.current = [];
    streamDone.current = false;
    if (typewriterTimer.current) {
      clearInterval(typewriterTimer.current);
      typewriterTimer.current = null;
    }

    const sid = crypto.randomUUID().slice(0, 8);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${agentHost}/agents/${agentName}/${sid}`,
    );
    wsRef.current = ws;

    ws.onopen = () => {
      if (messages.length === 0) {
        setMessages([
          {
            role: "bot",
            text: "👋 ¡Hola! Soy el asistente de Tp3studio. ¿En qué puedo ayudarte?",
          },
        ]);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "chat-response") {
          // Non-streaming fallback (error, welcome)
          streamDone.current = true;
          setMessages((prev) => [...prev, { role: "bot", text: data.message }]);
          setLoading(false);
        } else if (data.type === "chat-chunk") {
          if (!data.done) {
            // First chunk: start the typewriter
            if (!typewriterTimer.current) {
              startTypewriter();
            }
            typewriterQueue.current.push(data.text || "");
          } else {
            // Stream finished — let the typewriter drain the queue naturally
            streamDone.current = true;
          }
        }
      } catch {}
    };

    ws.onerror = () => {
      streamDone.current = true;
      if (typewriterTimer.current) {
        clearInterval(typewriterTimer.current);
        typewriterTimer.current = null;
      }
      setMessages((prev) => [
        ...prev,
        { role: "bot", text: "⚠ Error al conectar con el asistente." },
      ]);
      setLoading(false);
    };

    ws.onclose = () => {
      streamDone.current = true;
      if (typewriterTimer.current) {
        clearInterval(typewriterTimer.current);
        typewriterTimer.current = null;
      }
      wsRef.current = null;
    };
  }

  function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text }]);
    setLoading(true);

    const trySend = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const history = messages
          .filter((m) => m.role !== "error")
          .slice(-20)
          .map((m) => ({
            role: m.role === "bot" ? "assistant" : "user",
            content: m.text,
          }));
        wsRef.current.send(
          JSON.stringify({ type: "chat", message: text, history }),
        );
      } else {
        setTimeout(trySend, 200);
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
        .typing-indicator span { width:7px; height:7px; border-radius:50%; background:#6366F1; animation:typing-dot 1.4s infinite ease-in-out; }
        .typing-indicator span:nth-child(2) { animation-delay:.15s; }
        .typing-indicator span:nth-child(3) { animation-delay:.3s; }
        .bot-msg a { color:#6366F1; text-decoration:underline; }
        .bot-msg a:hover { color:#4F46E5; }
        .bot-msg code { background:rgba(99,102,241,.12); color:#6366F1; padding:1px 5px; border-radius:4px; font-size:.9em; font-family:monospace; }
        .bot-msg strong { font-weight:600; color:#18181B; }
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
        <button onClick={() => {connectWs(); setOpen(true);}}
          style={{position:"fixed",bottom:24,right:24,zIndex:9999,width:56,height:56,borderRadius:16,background:"#6366F1",color:"#fff",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 24px rgba(0,0,0,.12)"}}
          aria-label="Abrir chat">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      )}

      {open && (
        <div className={closing ? "chat-window-out" : "chat-window"}
          style={{position:"fixed",bottom:24,right:24,zIndex:9998,width:chatWidth,maxWidth:"calc(100vw - 48px)",height:chatHeight,maxHeight:"calc(100vh - 48px)",background:"#fff",display:"flex",flexDirection:"column",borderRadius:16,overflow:"hidden",boxShadow:"0 12px 48px rgba(0,0,0,.18)"}}>
          <div style={{background:"#6366F1",color:"#fff",padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
            <div>
              <div style={{fontFamily:"Outfit,sans-serif",fontWeight:600,fontSize:16}}>Tp3studio</div>
              <div style={{fontSize:12,opacity:.75,marginTop:1}}>Asistente virtual</div>
            </div>
            <button onClick={()=>{wsRef.current?.close(); setClosing(true);setTimeout(()=>{setOpen(false);setClosing(false)},250)}}
              style={{width:32,height:32,borderRadius:12,background:"rgba(255,255,255,.1)",border:"none",color:"#fff",cursor:"pointer"}} aria-label="Cerrar chat">✕</button>
          </div>

          <div style={{flex:1,overflowY:"auto",padding:"12px 16px",display:"flex",flexDirection:"column",gap:10,fontFamily:"Nunito,sans-serif"}}>
            {messages.map((m,i) => (
              <div key={i} className={m.role === "bot" ? "bot-msg" : ""}
                style={{maxWidth:"85%",padding:"10px 14px",borderRadius:16,fontSize:14,lineHeight:1.45,
                alignSelf:m.role==="user"?"flex-end":"flex-start",
                background:m.role==="user"?"#6366F1":"#F4F4F5",
                color:m.role==="user"?"#fff":"#18181B",
                borderBottomRightRadius:m.role==="user"?4:16,
                borderBottomLeftRadius:m.role==="user"?16:4}}>
                {m.role === "bot"
                  ? <span dangerouslySetInnerHTML={{__html: renderMarkdown(m.text)}} />
                  : m.text
                }
              </div>
            ))}
            {loading && <div className="typing-indicator" style={{alignSelf:"flex-start",background:"#F4F4F5",borderRadius:16,borderBottomLeftRadius:4}}><span></span><span></span><span></span></div>}
            <div ref={messagesEnd}/>
          </div>

          <form onSubmit={e=>{e.preventDefault();send()}} style={{display:"flex",gap:8,padding:"12px 16px 16px",borderTop:"1px solid #E4E4E7",flexShrink:0}}>
            <input ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} placeholder="Escribe tu mensaje..." disabled={loading}
              style={{flex:1,padding:"10px 14px",border:"1px solid #E4E4E7",borderRadius:12,fontSize:14,outline:"none",fontFamily:"Nunito,sans-serif"}}/>
            <button type="submit" disabled={loading||!input.trim()}
              style={{width:40,height:40,borderRadius:12,background:"#6366F1",color:"#fff",border:"none",cursor:"pointer",opacity:loading||!input.trim()?.4:1}} title="Enviar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </form>
        </div>
      )}
    </>
  );
}

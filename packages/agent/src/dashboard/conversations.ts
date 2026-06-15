/**
 * Conversations dashboard page — table of past conversations with expandable detail.
 */
export function conversationsPage(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conversaciones — Dashboard Agente</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f8f9fa;
    --card: #ffffff;
    --text: #1a1a2e;
    --muted: #6c757d;
    --border: #e2e8f0;
    --primary: #2563eb;
    --primary-fg: #fff;
    --radius: 12px;
    --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  nav { background: var(--card); border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; align-items: center; gap: 24px; height: 56px; box-shadow: var(--shadow); }
  nav a { text-decoration: none; color: var(--muted); font-size: 14px; font-weight: 500; padding: 8px 0; border-bottom: 2px solid transparent; transition: all 0.15s; }
  nav a:hover, nav a.active { color: var(--primary); border-bottom-color: var(--primary); }
  nav .brand { font-weight: 700; color: var(--text); font-size: 16px; margin-right: auto; }
  main { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); border: 1px solid var(--border); }
  th, td { padding: 12px 16px; text-align: left; font-size: 14px; }
  th { background: var(--bg); font-weight: 600; color: var(--muted); text-transform: uppercase; font-size: 12px; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
  td { border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f1f5f9; cursor: pointer; }
  .conv-id { font-family: monospace; font-size: 12px; color: var(--muted); }
  .msg-count { font-weight: 600; }
  .detail { display: none; background: var(--bg); padding: 16px; border-bottom: 1px solid var(--border); }
  .detail.open { display: block; }
  .bubble { max-width: 80%; padding: 10px 14px; border-radius: 16px; font-size: 14px; line-height: 1.5; margin-bottom: 8px; }
  .bubble.user { background: var(--primary); color: var(--primary-fg); margin-left: auto; border-bottom-right-radius: 4px; }
  .bubble.assistant { background: #f1f5f9; color: var(--text); margin-right: auto; border-bottom-left-radius: 4px; }
  .bubble.tool { background: #fef3c7; color: #92400e; margin-right: auto; border-bottom-left-radius: 4px; font-family: monospace; font-size: 12px; }
  .bubble-meta { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .pagination { display: flex; gap: 12px; align-items: center; justify-content: center; margin-top: 24px; }
  .pagination button { padding: 8px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); cursor: pointer; font-size: 14px; }
  .pagination button:disabled { opacity: 0.4; cursor: default; }
  .pagination span { font-size: 14px; color: var(--muted); }
  .empty { text-align: center; padding: 48px; color: var(--muted); }
  .error-state { text-align: center; padding: 48px; color: var(--danger); }
</style>
</head>
<body>
<nav>
  <span class="brand">Dashboard Agente</span>
  <a href="/admin">Overview</a>
  <a href="/admin/conversations" class="active">Conversaciones</a>
  <a href="/admin/prompts">Prompts</a>
</nav>
<main>
  <h1>Conversaciones</h1>
  <div id="table-wrap">
    <table>
      <thead><tr><th>ID</th><th>Fecha</th><th>Mensajes</th><th>Último mensaje</th></tr></thead>
      <tbody id="tbody"><tr><td colspan="4" class="empty">Cargando...</td></tr></tbody>
    </table>
  </div>
  <div class="pagination" id="pager"></div>
</main>
<script>
let page = 0;
const limit = 50;

async function load() {
  const tbody = document.getElementById("tbody");
  const pager = document.getElementById("pager");
  try {
    const resp = await fetch("/admin/api/conversations?limit=" + limit + "&offset=" + (page * limit));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    const convs = data.conversations || [];

    if (convs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No hay conversaciones todavía.</td></tr>';
    } else {
      tbody.innerHTML = convs.map(c => \`
        <tr onclick="toggleDetail('\${c.id}')" title="Click para ver detalle">
          <td><span class="conv-id">\${c.id.slice(0, 8)}...</span></td>
          <td>\${c.created_at ? new Date(c.created_at).toLocaleString() : "—"}</td>
          <td><span class="msg-count">\${c.message_count || 0}</span></td>
          <td>\${esc(c.last_message || "—").slice(0, 80)}</td>
        </tr>
        <tr id="detail-\${c.id}" class="detail"><td colspan="4"><div class="spinner-sm"></div>Cargando mensajes...</td></tr>
      \`).join("");
    }

    pager.innerHTML = \`
      <button onclick="go(-1)" \${page === 0 ? "disabled" : ""}>← Anterior</button>
      <span>Página \${page + 1}</span>
      <button onclick="go(1)" \${convs.length < limit ? "disabled" : ""}>Siguiente →</button>
    \`;
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="error-state">Error: ' + err.message + '</td></tr>';
  }
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

async function toggleDetail(id) {
  const row = document.getElementById("detail-" + id);
  if (!row) return;
  if (row.classList.contains("open")) {
    row.classList.remove("open");
    return;
  }
  row.classList.add("open");
  try {
    const resp = await fetch("/admin/api/conversations/" + id);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    const msgs = data.messages || [];
    row.innerHTML = '<td colspan="4">' + msgs.map(m => {
      const role = m.role === "assistant" ? "Ananda" : m.role === "tool" ? "Tool" : "Usuario";
      return \`<div class="bubble \${m.role}"><div class="bubble-meta">\${role} · \${new Date(m.created_at).toLocaleTimeString()}</div>\${esc(m.content)}</div>\`;
    }).join("") + '</td>';
  } catch (err) {
    row.innerHTML = '<td colspan="4"><div class="error-state">Error al cargar: ' + err.message + '</div></td>';
  }
}

function go(dir) { page += dir; load(); }
load();
</script>
</body>
</html>`;
}

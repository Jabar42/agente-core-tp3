/**
 * Prompt editor dashboard page — tabbed editor for SOUL, SKILLS, RULES, CONTEXT fragments.
 */
export function promptsPage(clientId: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Editor de Prompts — Dashboard Agente</title>
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
    --success: #16a34a;
    --radius: 12px;
    --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  nav { background: var(--card); border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; align-items: center; gap: 24px; height: 56px; box-shadow: var(--shadow); }
  nav a { text-decoration: none; color: var(--muted); font-size: 14px; font-weight: 500; padding: 8px 0; border-bottom: 2px solid transparent; transition: all 0.15s; }
  nav a:hover, nav a.active { color: var(--primary); border-bottom-color: var(--primary); }
  nav .brand { font-weight: 700; color: var(--text); font-size: 16px; margin-right: auto; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .subtitle { font-size: 14px; color: var(--muted); margin-bottom: 24px; }
  .tabs { display: flex; gap: 0; border-bottom: 2px solid var(--border); margin-bottom: 24px; }
  .tabs button { padding: 10px 20px; border: none; background: none; font-size: 14px; font-weight: 500; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.15s; }
  .tabs button:hover { color: var(--text); }
  .tabs button.active { color: var(--primary); border-bottom-color: var(--primary); }
  .card { background: var(--card); border-radius: var(--radius); padding: 24px; box-shadow: var(--shadow); border: 1px solid var(--border); }
  .card label { display: block; font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .card textarea { width: 100%; min-height: 320px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; font-family: monospace; font-size: 13px; line-height: 1.6; resize: vertical; background: #fafbfc; }
  .card textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
  .actions { display: flex; gap: 12px; align-items: center; margin-top: 16px; }
  .btn { padding: 10px 24px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .btn-primary { background: var(--primary); color: var(--primary-fg); }
  .btn-primary:hover { opacity: 0.9; }
  .btn-outline { background: var(--card); color: var(--text); border: 1px solid var(--border); }
  .btn-outline:hover { background: var(--bg); }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; color: #fff; opacity: 0; transform: translateY(8px); transition: all 0.3s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.success { background: #16a34a; }
  .toast.error { background: #dc2626; }
  .status { font-size: 13px; color: var(--muted); }
  .status.saved { color: var(--success); }
</style>
</head>
<body>
<nav>
  <span class="brand">Dashboard Agente</span>
  <a href="/admin">Overview</a>
  <a href="/admin/conversations">Conversaciones</a>
  <a href="/admin/prompts" class="active">Prompts</a>
</nav>
<main>
  <h1>Editor de Prompts</h1>
  <p class="subtitle">Editá la personalidad y conocimiento del agente en runtime. Los cambios se aplican al instante, sin redeploy.</p>
  <div class="tabs">
    <button data-tab="SOUL" class="active">SOUL</button>
    <button data-tab="SKILLS">SKILLS</button>
    <button data-tab="RULES">RULES</button>
    <button data-tab="CONTEXT">CONTEXT</button>
  </div>
  <div class="card">
    <label id="fragment-label">SOUL — Identidad y personalidad</label>
    <textarea id="editor" placeholder="Cargando..."></textarea>
    <div class="actions">
      <button class="btn btn-primary" onclick="save()">Guardar cambios</button>
      <button class="btn btn-outline" onclick="resetFragment()">↺ Resetear a default</button>
      <span class="status" id="status"></span>
    </div>
  </div>
  <div class="toast" id="toast"></div>
</main>
<script>
const CLIENT_ID = "${clientId}";
const fragments = ["SOUL", "SKILLS", "RULES", "CONTEXT"];
const descriptions = {
  SOUL: "SOUL — Identidad y personalidad",
  SKILLS: "SKILLS — Capacidades, servicios y FAQs",
  RULES: "RULES — Restricciones absolutas de comportamiento",
  CONTEXT: "CONTEXT — Datos del negocio, precios, ubicación",
};
let currentFragment = "SOUL";
let originalContent = "";
let promptsCache = {};

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

async function loadCurrent() {
  const editor = document.getElementById("editor");
  const status = document.getElementById("status");
  editor.value = "Cargando...";
  status.textContent = "";
  // Retry up to 3 times — DO may be cold (hibernating)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch("/admin/api/prompts");
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (!data.prompts || data.prompts.length === 0) throw new Error("Empty response");
      promptsCache = {};
      data.prompts.forEach((p: any) => { promptsCache[p.fragment] = p.content; });
      editor.value = promptsCache[currentFragment] || "";
      originalContent = editor.value;
      document.getElementById("fragment-label")!.textContent = descriptions[currentFragment];
      status.textContent = editor.value ? "✓ Cargado" : "";
      status.className = "status";
      return;
    } catch (err: any) {
      if (attempt < 2) {
        status.textContent = "Reintentando (" + (attempt + 2) + "/3)...";
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      editor.value = "";
      status.textContent = "Error al cargar: " + err.message;
      status.className = "status";
    }
  }
}

async function save() {
  const editor = document.getElementById("editor");
  const content = editor.value;
  const status = document.getElementById("status");
  const toast = document.getElementById("toast");

  try {
    const resp = await fetch("/admin/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, fragment: currentFragment, content }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || "HTTP " + resp.status);
    }
    originalContent = content;
    promptsCache[currentFragment] = content;
    const isReset = !content || !content.trim();
    status.textContent = isReset ? "✓ Reseteado a default " + new Date().toLocaleTimeString() : "✓ Guardado " + new Date().toLocaleTimeString();
    status.className = "status saved";
    if (isReset) {
      editor.value = "";
      showToast("Prompt reseteado al default compilado ✓", "success");
      // Reload to show compiled default
      setTimeout(loadCurrent, 500);
    } else {
      showToast("Prompt guardado correctamente ✓", "success");
    }
  } catch (err) {
    showToast("Error: " + err.message, "error");
  }
}

async function resetFragment() {
  const editor = document.getElementById("editor");
  if (!editor.value.trim()) {
    showToast("Ya está en default (textarea vacío)", "error");
    return;
  }
  if (!confirm("¿Resetear " + currentFragment + " al default compilado? El texto actual se perderá.")) return;
  editor.value = "";
  await save();
}

function showToast(msg, type) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className = "toast " + type + " show";
  setTimeout(() => { toast.className = "toast"; }, 3000);
}

// Tab switching
document.querySelectorAll(".tabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const editor = document.getElementById("editor");
    // Save current content to cache before switching
    promptsCache[currentFragment] = editor.value;
    currentFragment = btn.dataset.tab;
    editor.value = promptsCache[currentFragment] || "";
    originalContent = editor.value;
    document.getElementById("fragment-label").textContent = descriptions[currentFragment];
    document.getElementById("status").textContent = editor.value ? "" : "(sin editar — usando default compilado)";
    document.getElementById("status").className = "status";
  });
});

// Warn before leaving with unsaved changes
window.addEventListener("beforeunload", (e) => {
  const editor = document.getElementById("editor");
  if (editor.value !== originalContent) {
    e.preventDefault();
    e.returnValue = "";
  }
});

loadCurrent();
</script>
</body>
</html>`;
}

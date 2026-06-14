# Plan: Dashboard del Agente (Analytics + Prompt Editor)

## Contexto del ecosistema

### Repositorios

| Repo | Ruta local | Rama | Contenido |
|------|-----------|------|-----------|
| `agente-core-tp3` | `~/Documents/agente-core-tp3` | `master` | Monorepo: `packages/agent` (DO Worker), `packages/widget` (npm `@tp3/chat-widget`), `packages/mcp` (experimental) |
| `varsanaAstro` | `~/Documents/varsanaAstro` | `cf-migration` | Sitio Astro SSR + D1 + R2 + API REST (`/api/events`, `/api/pasadias`, `/api/images`) |
| `tp3studio` | `~/Documents/tp3studio` | `main` | Sitio agencia Tp3studio |

### Workers desplegados

| Worker | URL | Repo | Código |
|--------|-----|------|--------|
| `tp3studio-chat` | `tp3studio-chat.iaforchange.workers.dev` | agente-core-tp3/packages/agent | Agente Sofia (tp3studio) |
| `varsana-chat` | `varsana-chat.iaforchange.workers.dev` | agente-core-tp3/packages/agent | Agente Ananda (varsana), tool-calling REST |
| `varsana-mcp` | `varsana-mcp.iaforchange.workers.dev` | agente-core-tp3/packages/mcp | MCP server (experimental) |
| `varsana-co` | `varsana-co.iaforchange.workers.dev` | varsanaAstro | Sitio Astro SSR + D1 + R2 |
| `tp3studio` | `tp3studio.iaforchange.workers.dev` | tp3studio | Sitio Astro SSR |

### Cómo funciona el agente hoy

- **DO**: `Tp3ChatAgent` extiende `Agent<Env>`. SQLite provisionado (`new_sqlite_classes` en wrangler)
- **onMessage()**: recibe mensaje del widget vía WebSocket → llama a `streamDeepSeek()` → devuelve chunks SSE al widget
- **streamDeepSeek()**: `fetch` a `https://api.deepseek.com/v1/chat/completions` con `stream: true`, model `deepseek-chat`, `max_tokens: 1024` (2048 con tools), `temperature: 0.7`. Soporta `tools` array vía function calling nativo de DeepSeek
- **Tool-calling**: `TOOL_DEFINITIONS` hardcodea `get_events` y `get_pasadias` → `executeToolCall()` hace `fetch` a `TOOLS_URL/api/events` 
- **Estado actual**: **CERO persistencia**. No guarda historial, no cuenta métricas, no registra tool calls
- **Prompts**: `.md` files importados como texto en build-time vía esbuild Text loader. Compuestos en `prompts.ts` → `PROMPTS` map. **No editables en runtime**

### Stack del agente

- `agents` ^0.15.0 (Cloudflare Agents SDK)
- `deepseek-chat` vía fetch directo
- `wrangler` ^4.97.0
- SQLite vía `this.sql<>()` (provisionado, sin usar)
- DO methods: `this.getConnections()`, `this.setState()`, `this.ctx.storage`

### Plan Cloudflare

**Workers Paid** ($5/mes). El plan gratuito tiene 10ms CPU insuficiente para DO + tool-calling.

## El problema

- No hay visibilidad: ¿cuántas conversaciones? ¿qué preguntan? ¿funcionan los tool calls?
- Los prompts son código — editarlos requiere redeploy. El equipo de marketing no puede ajustar la personalidad del agente

## Arquitectura

**Sin Worker nuevo.** El dashboard se sirve desde el mismo agente (`varsana-chat`). El fetch handler del agente ya maneja HTTP — agregamos rutas `/admin/*` que devuelven HTML.

```
varsana-chat.iaforchange.workers.dev
├── /health                          ← ya existe
├── /api/chat                        ← ya existe
├── /admin                           ← NUEVO: sirve overview.html
├── /admin/conversations             ← NUEVO: sirve conversations.html
├── /admin/prompts                   ← NUEVO: sirve prompts.html
├── /admin/api/stats                 ← NUEVO: endpoint JSON (métricas)
├── /admin/api/conversations         ← NUEVO: endpoint JSON (lista)
├── /admin/api/conversations/:id     ← NUEVO: endpoint JSON (detalle)
├── /admin/api/prompts               ← NUEVO: endpoint JSON (GET)
└── /admin/api/prompts               ← NUEVO: endpoint JSON (POST, guardar)
```

### Frontend: 3 HTML strings en el bundle del agente

Cada página es un template literal de ~200 líneas con CSS inline + JS vanilla. Se importan como strings y se devuelven desde el fetch handler. Sin React, sin build separado, sin npm extra.

```
packages/agent/src/
├── index.ts              ← fetch handler + DO
├── prompts.ts            ← getSystemPrompt()
├── dashboard/
│   ├── overview.ts       ← exporta string HTML
│   ├── conversations.ts  ← exporta string HTML
│   ├── prompts.ts        ← exporta string HTML (editor)
│   └── api.ts            ← funciones que devuelven JSON
└── prompts/
    └── ...
```

Chart.js se carga desde CDN en el HTML (sin dependencia npm).

### Autenticación

Cloudflare Access (gratuito en Workers Paid). Protege las rutas `/admin/*` con OAuth (GitHub/Google). Se configura en `dash.cloudflare.com`, no en código.

## Implementación

### Fase 1: Backend — tablas SQLite + hooks

**Archivo:** `packages/agent/src/index.ts`

Crear las tablas en un método `initDb()` llamado desde `onConnect` (primera conexión del DO):

```sql
CREATE TABLE IF NOT EXISTS daily_metrics (
  date TEXT NOT NULL,
  client_id TEXT NOT NULL,
  messages INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0,
  tool_errors INTEGER DEFAULT 0,
  PRIMARY KEY (date, client_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  message_count INTEGER DEFAULT 0,
  last_message TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  name TEXT NOT NULL,
  args TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runtime_prompts (
  client_id TEXT NOT NULL,
  fragment TEXT NOT NULL CHECK(fragment IN ('SOUL','SKILLS','RULES','CONTEXT')),
  content TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, fragment)
);
```

**Hooks:**

- `onConnect`: crear fila en `conversations`, guardar `conversationId` en `ctx.storage` asociado al `connection.id`
- `onMessage`: registrar mensaje del usuario en `messages`, incrementar `conversations.message_count`, actualizar `daily_metrics`
- Tool callback: registrar `tool_calls` con nombre, args, success, duration_ms
- `streamDeepSeek` completion: registrar mensaje del assistant en `messages`

**`getSystemPrompt()` con override de runtime:**

```typescript
export function getSystemPrompt(clientId: string, db?: SqlStorage): string {
  if (db) {
    const rows = db.sql`SELECT fragment, content FROM runtime_prompts WHERE client_id = ${clientId}`;
    if (rows.length > 0) {
      // Construir prompt desde DB, fallback a compiled defaults para fragmentos no editados
      // ...
    }
  }
  return PROMPTS[clientId] ?? PROMPTS["tp3studio"];
}
```

El `db` se pasa desde `onMessage` (`this.sql`).

### Fase 2: Backend — endpoints JSON

**Archivo:** `packages/agent/src/dashboard/api.ts`

Funciones que reciben el `env` y devuelven `Response` JSON. El fetch handler del agente las llama cuando la URL matchea `/admin/api/*`.

| Ruta | Función | Query SQL |
|------|---------|-----------|
| `GET /admin/api/stats?client=varsana` | `getStats(env)` | `SELECT * FROM daily_metrics WHERE client_id = ? ORDER BY date DESC LIMIT 30` + `this.getConnections()` |
| `GET /admin/api/conversations?limit=50&offset=0` | `getConversations(env)` | `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?` |
| `GET /admin/api/conversations/:id` | `getConversation(env, id)` | `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC` |
| `GET /admin/api/prompts?client=varsana` | `getPrompts(env)` | `SELECT fragment, content FROM runtime_prompts WHERE client_id = ?` |
| `POST /admin/api/prompts` | `savePrompt(env, body)` | `INSERT INTO runtime_prompts ... ON CONFLICT ... DO UPDATE` |

### Fase 3: Frontend — HTML pages

**Archivos:** `packages/agent/src/dashboard/overview.ts`, `conversations.ts`, `prompts.ts`

Cada archivo exporta una función que retorna un string HTML completo con CSS inline + JS vanilla. Ejemplo:

```typescript
export function overviewPage(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Dashboard - Varsana</title>
<style>
  /* ~50 líneas de CSS para layout, tarjetas, tablas */
</style>
</head>
<body>
  <nav>...</nav>
  <div id="kpis">...</div>
  <canvas id="chart"></canvas>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    // ~100 líneas de JS: fetch /admin/api/stats, render KPIs, dibujar chart
  </script>
</body>
</html>`;
}
```

**Pantallas:**

1. **Overview** — KPIs (mensajes hoy, tool calls, tasa error, conexiones activas), gráfico de barras (últimos 30 días)
2. **Conversaciones** — Tabla con columnas: fecha, cliente, mensajes, último mensaje. Click → expande burbujas de chat
3. **Prompts** — Selector de cliente, 4 pestañas (SOUL/SKILLS/RULES/CONTEXT). Textarea + botón Guardar

### Fase 4: Fetch handler — routing

El fetch handler (`export default { async fetch(request, env) }`) agrega rutas:

```typescript
if (url.pathname === "/admin" || url.pathname === "/admin/") {
  return new Response(overviewPage(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
if (url.pathname === "/admin/conversations") {
  return new Response(conversationsPage(), { ... });
}
if (url.pathname === "/admin/prompts") {
  return new Response(promptsPage(), { ... });
}
if (url.pathname.startsWith("/admin/api/")) {
  return routeAdminApi(url, env, request);
}
```

### Fase 5: Deploy + Auth

1. Desplegar agente con Dashboard
2. Configurar Cloudflare Access en `dash.cloudflare.com` para proteger `/admin/*`
3. Mapear subdominio `agente.varsana.co` → `varsana-chat.iaforchange.workers.dev` (Cloudflare DNS)

## Archivos a modificar/crear

| Archivo | Acción |
|---------|--------|
| `packages/agent/src/index.ts` | +5 tablas SQLite, +hooks en lifecycle, +routing `/admin/*` en fetch handler |
| `packages/agent/src/prompts.ts` | +`getSystemPrompt` con override de runtime desde DB |
| `packages/agent/src/dashboard/api.ts` | **NUEVO** — Endpoints JSON (stats, conversations, prompts CRUD) |
| `packages/agent/src/dashboard/overview.ts` | **NUEVO** — HTML string para página de métricas |
| `packages/agent/src/dashboard/conversations.ts` | **NUEVO** — HTML string para historial |
| `packages/agent/src/dashboard/prompts.ts` | **NUEVO** — HTML string para editor de prompts |

## Verificación

```bash
# Después de deploy, usar el chat del widget un par de veces, luego:

# 1. Métricas accesibles
curl https://varsana-chat.iaforchange.workers.dev/admin/api/stats?client=varsana

# 2. Dashboard carga
curl https://varsana-chat.iaforchange.workers.dev/admin | head -20
# Debe devolver <!DOCTYPE html>...

# 3. Editor de prompts: guardar un cambio y verificar que el agente lo usa
curl -X POST https://varsana-chat.iaforchange.workers.dev/admin/api/prompts \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"varsana","fragment":"SOUL","content":"Eres Ananda 2.0..."}'
# Luego preguntar al agente en el widget y verificar que responde con la nueva personalidad
```

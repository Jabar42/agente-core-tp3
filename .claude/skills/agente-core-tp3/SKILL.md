# Agente Core Tp3 — Skill

Guía para trabajar con el monorepo `agente-core-tp3`: un agente de chat multi-cliente basado en Cloudflare Workers Agents SDK + DeepSeek, con widget React publicable a npm.

## Arquitectura

```
agente-core-tp3/
├── packages/
│   ├── agent/              ← Worker Cloudflare (Agents SDK + DeepSeek)
│   │   ├── src/
│   │   │   ├── index.ts           ← Tp3ChatAgent + fetch handler + SSE streaming
│   │   │   ├── prompts.ts         ← Mapa estático multi-cliente
│   │   │   └── prompts/
│   │   │       └── <cliente>/     ← SOUL.md, SKILLS.md, RULES.md, CONTEXT.md
│   │   ├── wrangler-<cliente>.jsonc  ← Una config por cliente
│   │   └── deploy.sh              ← Deploy selectivo por cliente
│   └── widget/             ← @tp3/chat-widget (React, publicable a npm)
│       └── src/ChatWidget.tsx
└── package.json            ← npm workspaces root
```

**Un solo worker atiende a N clientes.** Cada cliente se identifica por `CLIENT_ID` (variable de entorno en wrangler). El sistema de prompts selecciona los `.md` correspondientes al cliente en runtime.

## Cómo se relacionan los repos

```
┌─ agente-core-tp3 (fuente de verdad del agente) ─────┐
│                                                      │
│  packages/agent/                                     │
│  ├─ ./deploy.sh tp3studio                            │
│  │  → despliega tp3studio-chat.iaforchange.workers.dev   │
│  │                                                  │
│  └─ ./deploy.sh varsana (futuro)                    │
│     → despliega varsana-chat.iaforchange.workers.dev│
│                                                      │
│  packages/widget/                                    │
│  └─ editar → build → bump → npm publish             │
│     → @tp3/chat-widget se actualiza en npm          │
│                                                      │
└──────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─ tp3studio.com ───┐    ┌─ varsana.co ──────────┐
│ npm update widget  │    │ npm update widget     │
│ npm run deploy     │    │ deploy                │
└────────────────────┘    └───────────────────────┘
```

### Workers por proyecto — dos workers distintos

Cada proyecto de Tp3studio usa **dos workers separados**:

| Worker | URL | Repo | Qué hace |
|--------|-----|------|----------|
| `tp3studio` | `tp3studio.iaforchange.workers.dev` | tp3studio | Sirve el HTML del sitio (Astro SSR) |
| `tp3studio-chat` | `tp3studio-chat.iaforchange.workers.dev` | agente-core-tp3 | WebSocket + API del agente IA |

El widget (`@tp3/chat-widget`) se conecta por WebSocket al worker del agente, no al worker del sitio.

### Tres workflows independientes

**Workflow 1 — Editar el agente (comportamiento/prompts):**
```
1. Editar prompts/ o index.ts en packages/agent/
2. ./deploy.sh <cliente>
3. El worker se actualiza instantáneamente en Cloudflare
   → los widgets de todos los sitios ven el cambio sin tocar nada
```

**Workflow 2 — Editar el widget (UI/UX):**
```
1. Editar ChatWidget.tsx en packages/widget/
2. npm run build
3. Bump version (0.1.3 → 0.1.4)
4. npm publish --access public
5. En cada sitio: npm update @tp3/chat-widget + deploy
   → el widget nuevo se empaqueta en el build del sitio
```

**Workflow 3 — Agregar un cliente nuevo:**
```
1. Crear prompts/<cliente>/ con sus 4 .md
2. Agregar entrada al mapa en prompts.ts
3. Crear wrangler-<cliente>.jsonc (copiar de tp3studio)
4. Setear DEEPSEEK_API_KEY como secret
5. ./deploy.sh <cliente>
   → nuevo worker independiente en Cloudflare
6. En el sitio del cliente: npm install @tp3/chat-widget
   → <ChatWidget agentHost="<cliente>-chat.iaforchange.workers.dev" />
```

**El worker original de tp3studio NO se eliminó.** El código se movió de `tp3studio/src/workers/` a `agente-core-tp3/packages/agent/src/`, pero se despliega con el mismo `name: "tp3studio-chat"`. La URL `tp3studio-chat.iaforchange.workers.dev` sigue siendo la misma.

## Workflows operativos

### Agregar un cliente nuevo

1. **Crear carpeta de prompts:**
   ```bash
   cp -r packages/agent/src/prompts/tp3studio packages/agent/src/prompts/<nuevo-cliente>
   ```

2. **Editar los 4 `.md`** con la identidad, skills, reglas y contexto del nuevo cliente.

3. **Registrar en `prompts.ts`:**
   ```ts
   import nuevo_soul from "./prompts/<nuevo-cliente>/SOUL.md";
   import nuevo_skills from "./prompts/<nuevo-cliente>/SKILLS.md";
   import nuevo_rules from "./prompts/<nuevo-cliente>/RULES.md";
   import nuevo_context from "./prompts/<nuevo-cliente>/CONTEXT.md";

   const PROMPTS: Record<string, string> = {
     tp3studio: [...],
     "<nuevo-cliente>": [nuevo_soul, nuevo_skills, nuevo_rules, nuevo_context]
       .map((s) => s.trim()).join("\n\n"),
   };
   ```

4. **Crear wrangler config:**
   ```bash
   cp packages/agent/wrangler-tp3studio.jsonc packages/agent/wrangler-<nuevo-cliente>.jsonc
   ```
   Editar: cambiar `name`, `CLIENT_ID` en `vars`.

5. **Setear secretos:**
   ```bash
   cd packages/agent
   echo "sk-..." | npx wrangler -c wrangler-<nuevo-cliente>.jsonc secret put DEEPSEEK_API_KEY
   ```

6. **Desplegar:**
   ```bash
   cd packages/agent
   ./deploy.sh <nuevo-cliente>
   ```

### Hacer deploy

```bash
cd packages/agent

# Un cliente específico
./deploy.sh tp3studio

# Todos los clientes
./deploy.sh
```

El script busca `wrangler-<cliente>.jsonc` y ejecuta `wrangler deploy -c` con esa config.

### Editar prompts de un cliente existente

Los prompts viven en `packages/agent/src/prompts/<cliente>/`. Cada archivo tiene un propósito claro:

| Archivo | Qué va | Ejemplo |
|---------|--------|---------|
| `SOUL.md` | Identidad, personalidad, tono | "Eres Sofia, asistente de Tp3studio..." |
| `SKILLS.md` | Capacidades, servicios, FAQs | "Explicar planes, calificar leads..." |
| `RULES.md` | Restricciones absolutas | "No inventes, no prometas plazos..." |
| `CONTEXT.md` | Datos del negocio, precios | "Plan Esencial $100 USD..." |

Después de editar, redesplegar:
```bash
cd packages/agent && ./deploy.sh <cliente>
```

### Personalizar el widget con CSS custom properties

El widget define 13 variables CSS con defaults. Para personalizarlo, redefinilas en tu CSS:

```css
:root {
  --chat-primary: #4A7C59;          /* Header, botón, burbuja usuario */
  --chat-primary-fg: #fff;          /* Texto sobre primary */
  --chat-primary-hover: #3A6348;    /* Hover de links */
  --chat-bot-bubble: #F0F2F0;      /* Fondo burbuja del bot */
  --chat-bot-text: #1A1A1A;        /* Texto burbuja del bot */
  --chat-font-heading: "Proza Libre", sans-serif;
  --chat-font-body: "Inter", sans-serif;
  --chat-border: #D4D4D4;          /* Bordes del input y separadores */
  --chat-shadow: 0 8px 24px rgba(0,0,0,.12);
  --chat-shadow-lg: 0 12px 48px rgba(0,0,0,.18);
  --chat-code-bg: rgba(74,124,89,.12); /* Fondo de <code> */
  --chat-close-btn-bg: rgba(255,255,255,.15);
}
```

**Props adicionales del componente:**
| Prop | Default | Descripción |
|------|---------|-------------|
| `agentHost` | *(requerido)* | Host del Worker |
| `agentName` | `"tp3-chat-agent"` | DO binding en kebab-case |
| `brandName` | `"Tp3studio"` | Nombre en el header |
| `brandSubtitle` | `"Asistente virtual"` | Subtítulo en el header |
| `welcomeMessage` | `"👋 ¡Hola!..."` | Mensaje de bienvenida |

### Publicar el widget a npm

```bash
cd packages/widget

# Build (genera dist/)
npm run build

# Publicar
npm publish --access public
```

Luego en cualquier proyecto:
```bash
npm install @tp3/chat-widget
```

```tsx
import ChatWidget from "@tp3/chat-widget";
<ChatWidget agentHost="tp3studio-chat.iaforchange.workers.dev" />
```

La prop `agentHost` es obligatoria. `agentName` es opcional (default: `"tp3-chat-agent"`).

## Convenciones

### Nombrado de workers
- Pattern: `<cliente>-chat`
- Ejemplo: `tp3studio-chat`, `varsana-chat`
- El `name` en `wrangler-*.jsonc` define la URL: `https://<name>.<subdomain>.workers.dev`

### Secretos requeridos por worker
| Secreto | Propósito |
|---------|-----------|
| `DEEPSEEK_API_KEY` | API key de DeepSeek |

### DO class name
Siempre `Tp3ChatAgent`. No renombrar — hay migraciones de DO que dependen de este nombre.

### Formato de prompts
- Markdown puro — se concatenan con `\n\n`
- Orden: SOUL → SKILLS → RULES → CONTEXT
- Se envían como system prompt a DeepSeek
- El worker los lee en cada request (pueden cambiarse sin redeploy... pero el bundle los embebe, así que SÍ requieren redeploy)

## Archivos que no se tocan

- `packages/agent/src/index.ts` — solo si se cambia la lógica del agente (modelo, streaming, etc.)
- `packages/widget/src/ChatWidget.tsx` — solo si se cambia la UI/UX del widget
- `deploy.sh` — solo si cambia la estrategia de deploy

## Infraestructura del sitio cliente

Cada sitio cliente necesita su propio bucket R2 para imagenes (requiere Workers Paid):

```bash
npx wrangler r2 bucket create <cliente>-images
```

El binding en `wrangler.jsonc` del sitio:
```json
"r2_buckets": [{ "bucket_name": "<cliente>-images", "binding": "VARSANA_IMAGES" }]
```

El endpoint de imagenes usa `src/pages/api/images/[...key].ts` (catch-all Astro):
- `POST /api/images` con `multipart/form-data` (campo `file`) → sube a R2
- `GET /api/images/:key` → sirve desde R2 con cache inmutable

## Troubleshooting

| Error | Causa probable |
|-------|---------------|
| `does not export class 'Tp3ChatAgent'` | Se renombró la clase. No se debe renombrar. |
| `D1 binding (DB) not available` | Este worker no usa D1. Si se agregó, verificar wrangler config. |
| Widget conecta pero no responde | Verificar que `agentHost` apunte al worker correcto. |
| `CLIENT_ID` no se respeta | El `vars.CLIENT_ID` en wrangler se inyecta como env var. Verificar que esté en `wrangler-*.jsonc`. |

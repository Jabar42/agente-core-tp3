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
│   └── widget/             ← @tp3studio/chat-widget (React, publicable a npm)
│       └── src/ChatWidget.tsx
└── package.json            ← npm workspaces root
```

**Un solo worker atiende a N clientes.** Cada cliente se identifica por `CLIENT_ID` (variable de entorno en wrangler). El sistema de prompts selecciona los `.md` correspondientes al cliente en runtime.

## Workflows

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
npm install @tp3studio/chat-widget
```

```tsx
import ChatWidget from "@tp3studio/chat-widget";
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

## Troubleshooting

| Error | Causa probable |
|-------|---------------|
| `does not export class 'Tp3ChatAgent'` | Se renombró la clase. No se debe renombrar. |
| `D1 binding (DB) not available` | Este worker no usa D1. Si se agregó, verificar wrangler config. |
| Widget conecta pero no responde | Verificar que `agentHost` apunte al worker correcto. |
| `CLIENT_ID` no se respeta | El `vars.CLIENT_ID` en wrangler se inyecta como env var. Verificar que esté en `wrangler-*.jsonc`. |

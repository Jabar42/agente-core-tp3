# agente-core-tp3

Monorepo del agente de chat multi-cliente de Tp3studio. Worker Cloudflare con Agents SDK + DeepSeek, widget React publicable a npm.

## Commands

```bash
# Install
npm install

# Agent — deploy
cd packages/agent
./deploy.sh tp3studio          # Deploy cliente específico
./deploy.sh                    # Deploy todos los clientes

# Agent — dev
cd packages/agent
npx wrangler dev -c wrangler-tp3studio.jsonc

# Widget — build & publish
cd packages/widget
npm version patch        # Bump version (patch/minor/major)
npm run build            # Build (genera dist/)
npm publish --access public

# Actualizar widget en sitios cliente
cd ~/Documents/varsanaAstro && npm update @tp3/chat-widget && npm run build && npx wrangler deploy
cd ~/Documents/tp3studio && npm update @tp3/chat-widget && npm run deploy
```

## Architecture

```
packages/
├── agent/              ← Worker Cloudflare (Agents SDK + DeepSeek SSE)
│   ├── src/index.ts           ← Tp3ChatAgent + fetch handler
│   ├── src/prompts.ts         ← Mapa PROMPTS por cliente
│   └── src/prompts/<cliente>/ ← SOUL, SKILLS, RULES, CONTEXT (.md)
└── widget/             ← @tp3/chat-widget (React, publicable a npm)
    └── src/ChatWidget.tsx
```

## Requisitos del plan Cloudflare

**Workers Paid** ($5/mes) requerido para Durable Objects con SQLite, tool-calling DeepSeek, y R2.

## Infraestructura de un cliente nuevo (R2 + Imagenes)

Ademas de los pasos del agente, el sitio del cliente necesita:

1. **R2 bucket** para imagenes:
   ```bash
   npx wrangler r2 bucket create <cliente>-images
   ```
   Agregar al wrangler.jsonc del sitio:
   ```json
   "r2_buckets": [{ "bucket_name": "<cliente>-images", "binding": "VARSANA_IMAGES" }]
   ```

2. **API de imagenes**: copiar `src/pages/api/images/[...key].ts` de varsanaAstro.
   - `POST /api/images` → sube a R2, devuelve URL
   - `GET /api/images/:key` → sirve desde R2 con Cache-Control inmutable

## Workflow: agregar un nuevo cliente

Cuando el usuario pida desplegar un agente para un nuevo cliente, seguí estos pasos:

1. **Crear carpeta de prompts** en `packages/agent/src/prompts/<cliente>/` con 4 archivos:
   - `SOUL.md` — identidad, personalidad, tono
   - `SKILLS.md` — capacidades, servicios, FAQs
   - `RULES.md` — restricciones absolutas (8 reglas)
   - `CONTEXT.md` — datos del negocio, precios, ubicación

2. **Registrar en `prompts.ts`**: importar los 4 .md y agregar entry al mapa `PROMPTS`.

3. **Crear wrangler config**: copiar `wrangler-tp3studio.jsonc` a `wrangler-<cliente>.jsonc`, cambiar `name` (ej: "varsana-chat") y `CLIENT_ID` en `vars`.

4. **Setear API key**:
   ```bash
   cd packages/agent
   echo "sk-..." | npx wrangler -c wrangler-<cliente>.jsonc secret put DEEPSEEK_API_KEY
   ```

5. **Desplegar**:
   ```bash
   cd packages/agent
   ./deploy.sh <cliente>
   ```

6. **Instalar widget en el sitio del cliente**:
   ```bash
   npm install @tp3/chat-widget
   ```
   ```tsx
   import ChatWidget from '@tp3/chat-widget';
   <ChatWidget agentHost="<cliente>-chat.iaforchange.workers.dev" />
   ```

## Personalizar el widget con CSS

```css
:root {
  --chat-primary: #RRGGBB;
  --chat-primary-fg: #RRGGBB;
  --chat-font-heading: "Font Name", sans-serif;
  --chat-font-body: "Font Name", sans-serif;
  /* Ver SKILL.md para la lista completa de 12 variables */
}
```

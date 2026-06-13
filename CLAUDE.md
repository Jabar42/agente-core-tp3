# agente-core-tp3

Monorepo del agente de chat multi-cliente de Tp3studio. Worker Cloudflare con Agents SDK + DeepSeek, widget React publicable a npm.

## Commands

```bash
# Root (pnpm workspaces)
npm install

# Agent — deploy
cd packages/agent
./deploy.sh tp3studio          # Deploy cliente específico
./deploy.sh                    # Deploy todos los clientes

# Agent — dev
cd packages/agent
npx wrangler dev -c wrangler-tp3studio.jsonc

# Widget — build
cd packages/widget
npm run build
```

## Architecture

- `packages/agent` — Cloudflare Worker multi-cliente (Agents SDK + DeepSeek SSE)
- `packages/widget` — ChatWidget React con `agentHost` prop (publicable como `@tp3/chat-widget`)
- Prompts modulares por cliente: `SOUL.md`, `SKILLS.md`, `RULES.md`, `CONTEXT.md`

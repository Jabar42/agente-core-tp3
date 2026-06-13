# @tp3/chat-widget

Chat widget React para el agente de servicio al cliente de Tp3studio. Se conecta por WebSocket a un [Workers Agent SDK](https://developers.cloudflare.com/agents/) con DeepSeek.

## Instalación

```bash
npm install @tp3/chat-widget
```

## Uso

```tsx
import ChatWidget from "@tp3/chat-widget";

<ChatWidget agentHost="tp3studio-chat.iaforchange.workers.dev" />
```

### Props

| Prop | Default | Descripción |
|------|---------|-------------|
| `agentHost` | *(requerido)* | Host del Worker Cloudflare |
| `agentName` | `"tp3-chat-agent"` | DO binding en kebab-case |
| `brandName` | `"Tp3studio"` | Nombre en el header |
| `brandSubtitle` | `"Asistente virtual"` | Subtítulo en el header |
| `welcomeMessage` | `"👋 ¡Hola!..."` | Mensaje de bienvenida |

## Personalización

El widget expone 12 [CSS custom properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties) con defaults. Redefinelas en tu CSS:

```css
:root {
  --chat-primary: #4A7C59;
  --chat-primary-fg: #fff;
  --chat-primary-hover: #3A6348;
  --chat-bot-bubble: #F0F2F0;
  --chat-bot-text: #1A1A1A;
  --chat-font-heading: "Proza Libre", sans-serif;
  --chat-font-body: "Inter", sans-serif;
  --chat-border: #D4D4D4;
  --chat-shadow: 0 8px 24px rgba(0,0,0,.12);
  --chat-shadow-lg: 0 12px 48px rgba(0,0,0,.18);
  --chat-code-bg: rgba(74,124,89,.12);
  --chat-close-btn-bg: rgba(255,255,255,.15);
}
```

## Licencia

MIT

# Problema: Scroll del fondo detrás del ChatWidget

## Contexto del proyecto

`@tp3/chat-widget` es un widget React de chat (npm) que se conecta por WebSocket a un agente IA en Cloudflare Workers. Se instala en sitios Astro como `tp3studio.com` y `varsana.co`.

El widget se renderiza como un overlay `position: fixed` sobre la página:

```
┌──────────────────────────────────┐
│  Página (body, scrollable)       │
│  ┌─────────────────────────┐     │
│  │ Header                  │     │
│  │ Contenido...            │     │
│  │                         │     │
│  │     ┌──────────┐        │     │
│  │     │  CHAT    │  fixed │     │
│  │     │ Header   │        │     │
│  │     │ Mensajes │ scroll │     │
│  │     │ Input    │        │     │
│  │     └──────────┘        │     │
│  └─────────────────────────┘     │
│  ← scrollbar derecha             │
└──────────────────────────────────┘
```

## El problema

Cuando el chat está abierto (`position: fixed; bottom: 24px; right: 24px; width: 380px; height: 540px`), el scroll de la **página detrás** sigue activo. Esto causa dos síntomas:

### Desktop
- Al hacer scroll con la rueda del mouse sobre cualquier parte del chat que NO es el área de mensajes (header, input, espacio vacío entre burbujas), el evento `wheel` se propaga al `body` y la página detrás scrollea.
- Al llegar al final del scroll dentro de los mensajes, el scroll "encadena" (scroll chaining) y el excedente mueve la página de fondo.
- La barra de scroll derecha de la página es visible y se mueve.

### Mobile (iOS Safari y Android Chrome)
- Al hacer touch-scroll dentro del chat, si se llega al borde del área de mensajes, el gesto se transfiere al body y la página detrás scrollea.
- Cuando el teclado virtual está abierto (input enfocado), el viewport se reduce. Si se manipula el body (ej. `overflow: hidden`), el teclado puede cerrarse o la página saltar.
- El `overscroll-behavior: contain` no es suficiente en iOS Safari — el scroll chaining ocurre igual.

### Lo esperado
- Con el chat abierto, **solo el área de mensajes del chat debe scrollear**.
- La página detrás debe permanecer inmóvil.
- El teclado virtual debe funcionar normalmente.
- Al cerrar el chat, todo vuelve a la normalidad.

## Lo que se intentó

### Intento 1: `overflow: hidden` en `<html>`
```ts
document.documentElement.style.overflow = "hidden";
```
**Resultado:** Bloquea TODO el scroll, incluyendo el área de mensajes del chat. En iOS, el `overflow: hidden` en `<html>` deshabilita el scroll de cualquier hijo, incluso si tiene `overflow-y: auto`. No funciona.

### Intento 2: `position: fixed` en `<body>`
```ts
document.body.style.position = "fixed";
document.body.style.top = `-${scrollY}px`;
```
**Resultado:** En desktop bloquea el scroll del fondo pero el chat (que es `position: fixed`) scrollea independiente. En mobile, cuando el teclado virtual se abre, Safari/iOS recalculan el viewport y el elemento `fixed` del chat queda fuera de la zona táctil activa — el input no es accesible o la pantalla salta. No funciona en mobile.

### Intento 3: `overflow: hidden` en `<html>` (otra vez, pensando que era diferente de body)
Mismo resultado que intento 1.

### Intento 4: `position: fixed` en body + `overscroll-behavior: contain`
Combinación de intento 2 con CSS. Mismo resultado — el problema es `position: fixed` en body + teclado iOS.

### Intento 5: Listeners `wheel`/`touchmove` en toda la ventana del chat
```ts
el.addEventListener("wheel", (e) => e.preventDefault());
el.addEventListener("touchmove", (e) => e.preventDefault());
```
**Resultado:** Bloquea TODO el scroll, incluyendo dentro de los mensajes. Luego se refinó para solo bloquear fuera del área de mensajes (`data-chat-messages`), pero seguía bloqueando scroll legítimo en los bordes del área de mensajes.

### Intento 6: Handlers de borde (enfoque actual, v0.1.13)
```tsx
onWheel={(e) => {
  const el = e.currentTarget;
  const atTop = el.scrollTop === 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  if ((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)) {
    e.preventDefault();
  }
}}
onTouchMove={(e) => {
  // misma lógica con deltaY calculado desde touchStart
}}
```
**Resultado:** Solo bloquea en los bordes. Pero el problema persiste porque:
1. Los handlers están en el **área de mensajes** (div con `overflow-y: auto`). No cubren wheel/touch sobre el header, input, o espacio entre burbujas que no llenan el contenedor.
2. En desktop, si el mouse está sobre el header del chat y se usa la rueda, el evento va directo al body — los handlers del área de mensajes no lo capturan.
3. En mobile, el touch sobre el header o input también se escapa al body.
4. Cuando hay pocos mensajes y el contenedor no llena el área (gracias a `justify-content: flex-end`), hay un espacio vacío en la parte superior del área de mensajes donde los handlers de borde no aplican.

## Estructura actual del widget (v0.1.13)

```tsx
// Estructura simplificada
<div className="chat-window" style={{ position: "fixed", ... }}>
  <div style={{ /* header */ }}>Título</div>

  <div style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain" }}
       onWheel={...}    ← handlers de borde
       onTouchMove={...}>
    {messages.map(...)}
  </div>

  <form style={{ /* input area */ }}>
    <input ... />
    <button>Enviar</button>
  </form>
</div>
```

No hay manipulación de `body.style` ni `document.documentElement.style` en esta versión.

### Dependencias del widget
- React 18+ (peer dependency)
- Sin otras dependencias runtime
- CSS inline (no requiere archivos externos)

### Sitios donde se usa
- `tp3studio.com` — Astro 6, CSS vanilla
- `varsana.co` (staging) — Astro 6, Tailwind CSS 4

## Restricciones

1. **No se puede asumir nada del sitio host**. El widget se instala vía npm en sitios con diferentes frameworks CSS (Tailwind, vanilla, etc.). Cualquier manipulación del body/html debe ser segura y reversible.

2. **El teclado virtual en mobile no debe romperse**. Esto descarta `overflow: hidden` en `<html>` y `position: fixed` en `<body>`.

3. **El scroll dentro del chat debe funcionar normalmente**. Los mensajes deben poder scrollear sin fricción.

4. **La solución debe funcionar en**: Chrome, Firefox, Safari, iOS Safari, Android Chrome.

5. **No se pueden agregar dependencias pesadas**. El widget es ~16KB. Librerías como `body-scroll-lock` agregarían complejidad de mantenimiento y peso.

## Versiones relevantes del widget publicadas en npm

| Versión | Enfoque | Estado |
|---------|---------|--------|
| 0.1.11 | `overflow: hidden` en `<html>` | ❌ |
| 0.1.12 | `position: fixed` en body | ❌ |
| 0.1.13 | Handlers de borde en mensajes | ❌ |

## Preguntas abiertas

1. ¿Existe un enfoque que no requiera tocar el body/html y que capture wheel/touch en **toda** la ventana del chat (no solo el área de mensajes) sin bloquear el scroll interno?

2. ¿Hay una forma de prevenir el scroll chaining en iOS Safari que funcione consistentemente? `overscroll-behavior: contain` no es 100% efectivo en iOS.

3. ¿Es viable usar `touch-action: none` en el overlay del chat completo, y luego `touch-action: pan-y` solo en el área de mensajes?

4. ¿La solución debería ser diferente para desktop (wheel events) y mobile (touch events)?

---

*Documento generado para análisis por un experto LLM. El código fuente completo está en `packages/widget/src/ChatWidget.tsx` en el repo `agente-core-tp3`.*

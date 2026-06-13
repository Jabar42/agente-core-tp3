/**
 * Composes the system prompt for each client from their prompt fragments.
 *
 * Each .md file is imported as a raw text string via esbuild's Text loader
 * (configured in wrangler-*.jsonc rules).
 *
 * To add a new client:
 * 1. Create packages/agent/src/prompts/<client>/ with its 4 .md files
 * 2. Import them below and add an entry to the PROMPTS map
 * 3. Create a wrangler-<client>.jsonc with CLIENT_ID = "<client>"
 */
import tp3studio_soul from "./prompts/tp3studio/SOUL.md";
import tp3studio_skills from "./prompts/tp3studio/SKILLS.md";
import tp3studio_rules from "./prompts/tp3studio/RULES.md";
import tp3studio_context from "./prompts/tp3studio/CONTEXT.md";

const PROMPTS: Record<string, string> = {
  tp3studio: [
    tp3studio_soul,
    tp3studio_skills,
    tp3studio_rules,
    tp3studio_context,
  ]
    .map((s) => s.trim())
    .join("\n\n"),
};

export function getSystemPrompt(clientId: string): string {
  return PROMPTS[clientId] ?? PROMPTS["tp3studio"];
}

/**
 * Composes the system prompt for each client from their prompt fragments.
 *
 * Each .md file is imported as a raw text string via esbuild's Text loader
 * (configured in wrangler-*.jsonc rules).
 *
 * When a `db` (SqlStorage) is passed, runtime_prompts table overrides are
 * used in place of compiled defaults — this lets the dashboard edit prompts
 * without redeploying.
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
import varsana_soul from "./prompts/varsana/SOUL.md";
import varsana_skills from "./prompts/varsana/SKILLS.md";
import varsana_rules from "./prompts/varsana/RULES.md";
import varsana_context from "./prompts/varsana/CONTEXT.md";

/** Compiled defaults per fragment and client. Indexed as DEFAULTS[clientId][fragment]. */
export const DEFAULTS: Record<string, Record<string, string>> = {
  tp3studio: {
    SOUL: tp3studio_soul.trim(),
    SKILLS: tp3studio_skills.trim(),
    RULES: tp3studio_rules.trim(),
    CONTEXT: tp3studio_context.trim(),
  },
  varsana: {
    SOUL: varsana_soul.trim(),
    SKILLS: varsana_skills.trim(),
    RULES: varsana_rules.trim(),
    CONTEXT: varsana_context.trim(),
  },
};

/** Full compiled prompt per client (used when no DB override is available). */
const PROMPTS: Record<string, string> = {};
for (const [clientId, fragments] of Object.entries(DEFAULTS)) {
  PROMPTS[clientId] = [
    fragments.SOUL,
    fragments.SKILLS,
    fragments.RULES,
    fragments.CONTEXT,
  ].join("\n\n");
}

/**
 * Build the system prompt for a client.
 *
 * When `db` is provided, each fragment (SOUL, SKILLS, RULES, CONTEXT) is
 * looked up in the runtime_prompts table first. If a runtime override exists
 * it takes precedence; otherwise the compiled default is used.
 */
export function getSystemPrompt(
  clientId: string,
  db?: any, // Agents SDK this.sql tagged template — callable as db`...`
): string {
  const defaults = DEFAULTS[clientId] ?? DEFAULTS["tp3studio"];

  if (db) {
    try {
      const rows = db
        .sql`SELECT fragment, content FROM runtime_prompts WHERE client_id = ${clientId}` as { fragment: string; content: string }[];
      if (rows && rows.length > 0) {
        const overrides: Record<string, string> = {};
        for (const row of rows) {
          if (row.content && row.content.trim()) {
            overrides[row.fragment] = row.content;
          }
        }
        return [
          overrides.SOUL ?? defaults.SOUL,
          overrides.SKILLS ?? defaults.SKILLS,
          overrides.RULES ?? defaults.RULES,
          overrides.CONTEXT ?? defaults.CONTEXT,
        ].join("\n\n");
      }
    } catch {
      // Table may not exist yet — fall through to compiled default
    }
  }

  return PROMPTS[clientId] ?? PROMPTS["tp3studio"];
}

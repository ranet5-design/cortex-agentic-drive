/**
 * Claude wrapper. Every agent calls through here. If no credentials are
 * configured (or AGENT_MODE=offline), `enabled` is false and agents use their
 * offline heuristics instead, so the prototype always runs.
 */
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const hasCreds = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export const enabled = hasCreds && process.env.AGENT_MODE !== "offline";

const client = enabled ? new Anthropic() : null;

// Server-side refusal fallback: if Opus declines, the API reroutes to a
// recommended fallback model inside the same call.
const BASE = {
  model: MODEL,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

function textOf(message) {
  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined this request" + (message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : ""));
  }
  return message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Claude authentication failed (check ANTHROPIC_API_KEY)";
  if (err instanceof Anthropic.RateLimitError) return "Claude rate limit hit";
  if (err instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`;
  return err.message;
}

/** Structured call: returns a parsed object that matches `schema`. */
export async function json({ system, prompt, schema, effort = "low", maxTokens = 16000 }) {
  try {
    const message = await client.beta.messages.create({
      ...BASE,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort, format: { type: "json_schema", schema } },
    });
    return JSON.parse(textOf(message));
  } catch (err) {
    throw new Error(describeError(err));
  }
}

/** Long-form markdown generation (streamed to avoid HTTP timeouts). */
export async function write({ system, prompt, effort = "medium", maxTokens = 64000 }) {
  try {
    const stream = client.beta.messages.stream({
      ...BASE,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort },
    });
    return textOf(await stream.finalMessage());
  } catch (err) {
    throw new Error(describeError(err));
  }
}

/**
 * JSON-schema helper: every object gets additionalProperties:false and all of
 * its properties marked required, as structured outputs expect.
 */
export function obj(properties) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
export const str = (description) => ({ type: "string", ...(description ? { description } : {}) });
export const arr = (items, description) => ({ type: "array", items, ...(description ? { description } : {}) });
export const enumOf = (values, description) => ({ type: "string", enum: values, ...(description ? { description } : {}) });

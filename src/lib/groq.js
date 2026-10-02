// Groq chat-completions client — the same provider and model BeeBark uses.
// Groq speaks the OpenAI wire format; gpt-oss-120b is on its free tier.
// The model can be swapped with GROQ_MODEL without a code change.
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const BASE_URL = "https://api.groq.com/openai/v1/chat/completions";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestGroq(messages, model, apiKey) {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.3, response_format: { type: "json_object" } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // Groq's real reason (quota, bad key, …) is in the body, not the status.
    const body = await res.json().catch(() => ({}));
    const err = new Error(`Groq HTTP ${res.status}: ${body?.error?.message ?? res.statusText}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned no content");
  return text;
}

/** True when an API key is configured, so callers can skip straight to their fallback. */
export function groqConfigured() {
  return Boolean(process.env.GROQ_API_KEY);
}

/**
 * Sends a system + user prompt and returns the parsed JSON object.
 *
 * Throws on any failure so callers can fall back to non-AI behaviour.
 * Timeouts and 5xx are retried once. A 429 (the free tier's tokens-per-
 * minute limit, hit when the nightly job reviews several people in a row)
 * waits as long as Groq says to — up to 20s — and tries again, twice.
 */
export async function askGroqForJson(system, user) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured");
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let text;
  for (let attempt = 0; ; attempt++) {
    try {
      text = await requestGroq(messages, model, apiKey);
      break;
    } catch (err) {
      if (err.status === 429 && attempt < 2) {
        const hinted = Number(/try again in ([\d.]+)s/i.exec(err.message)?.[1]);
        await sleep(Math.min(Number.isFinite(hinted) ? hinted * 1000 + 500 : 8000, 20_000));
        continue;
      }
      if (err.status && err.status < 500) throw err;
      if (attempt >= 1) throw err;
      await sleep(1000);
    }
  }

  const match = text.match(/[[{][\s\S]*[\]}]/);
  if (!match) throw new Error("Groq did not return JSON");
  return JSON.parse(match[0]);
}

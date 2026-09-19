/**
 * LLM ACCESS LAYER
 * ============================================================================
 * One function, `tryGenerateJSON`, backed by a swappable provider. Set
 * LLM_PROVIDER in .env.local to choose:
 *
 *    gemini     Google Gemini via the REST API          <- default
 *    anthropic  Claude via the official Node SDK
 *    none       skip the LLM entirely
 *
 * ---------------------------------------------------------------------------
 * HOW TO GET A GEMINI API KEY  (the default provider — do this one)
 * ---------------------------------------------------------------------------
 *   1. Open  https://aistudio.google.com/apikey
 *   2. Sign in with any Google account.
 *   3. Click "Create API key" -> "Create API key in new project".
 *   4. Copy the key (it starts with "AIza") into GEMINI_API_KEY in .env.local.
 *
 *   Free tier, no credit card. Flash models have a large enough free quota for
 *   a hackathon demo; Pro models are much tighter.
 *     Rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
 *     Model list:  https://ai.google.dev/gemini-api/docs/models
 *     Pricing:     https://ai.google.dev/pricing
 *
 *   We call the REST endpoint directly with `fetch` rather than installing the
 *   Google SDK. Two reasons: one less dependency to break during a timed build,
 *   and the REST surface for structured output is stable and self-documenting.
 *
 * ---------------------------------------------------------------------------
 * HOW TO GET AN ANTHROPIC API KEY  (only if you set LLM_PROVIDER=anthropic)
 * ---------------------------------------------------------------------------
 *   1. Open  https://console.anthropic.com/
 *   2. Create an account -> Settings -> API Keys -> "Create Key".
 *   3. Copy the key (starts with "sk-ant-") into ANTHROPIC_API_KEY.
 *   4. Install the optional dependency:  npm install @anthropic-ai/sdk
 *
 *   No permanent free tier — new accounts get a small trial credit, after that
 *   you must add a payment method. Pricing: https://www.anthropic.com/pricing
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THAT MAKES THIS DEMO-SAFE
 * ---------------------------------------------------------------------------
 * `tryGenerateJSON` NEVER THROWS. It returns `{ ok: false, error }` on any
 * failure — missing key, rate limit, timeout, network error, malformed JSON,
 * schema mismatch. Every caller is therefore forced to have a deterministic
 * fallback path, and no live demo can be broken by a quota limit.
 * ============================================================================
 */

import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  LLM_PROVIDER,
  LLM_TIMEOUT_MS,
} from "./config.js";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

/**
 * Generate a JSON object from the model.
 *
 * @param {Object} args
 * @param {string} args.system        System instruction
 * @param {string} args.user          User content
 * @param {Object} [args.schema]      Gemini responseSchema (OpenAPI subset)
 * @param {number} [args.maxTokens]
 * @param {number} [args.temperature] Low by default — this is a scoring task
 * @returns {Promise<{ok: true, data: Object, provider: string, model: string, latency_ms: number}
 *                 | {ok: false, error: string, code: string}>}
 */
export async function tryGenerateJSON({
  system,
  user,
  schema = null,
  maxTokens = 1200,
  temperature = 0.2,
}) {
  const startedAt = Date.now();

  if (LLM_PROVIDER === "none") {
    return { ok: false, code: "llm_disabled", error: "LLM_PROVIDER is set to 'none'." };
  }

  let lastError = { code: "unknown", error: "No attempt was made." };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const text =
        LLM_PROVIDER === "anthropic"
          ? await callAnthropic({ system, user, schema, maxTokens, temperature })
          : await callGemini({ system, user, schema, maxTokens, temperature });

      const data = extractJson(text);
      if (data === null) {
        lastError = {
          code: "unparseable_response",
          error: "Model returned text that could not be parsed as JSON.",
        };
        // A reroll sometimes fixes this, so treat it as retryable.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_BACKOFF_MS * attempt);
          continue;
        }
        return { ok: false, ...lastError };
      }

      return {
        ok: true,
        data,
        provider: LLM_PROVIDER,
        model: LLM_PROVIDER === "anthropic" ? ANTHROPIC_MODEL : GEMINI_MODEL,
        latency_ms: Date.now() - startedAt,
        attempts: attempt,
      };
    } catch (error) {
      lastError = {
        code: error?.code ?? "provider_error",
        error: String(error?.message ?? error),
      };

      // Only retry things that might succeed next time.
      const retryable = error?.retryable !== false && attempt < MAX_ATTEMPTS;
      if (!retryable) break;

      // Exponential backoff with jitter, so three parallel surgeon lookups
      // don't all retry into the same rate-limit window.
      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 200;
      await sleep(delay);
    }
  }

  console.warn(`[llm] falling back to deterministic model: ${lastError.code} — ${lastError.error}`);
  return { ok: false, ...lastError };
}

// ---------------------------------------------------------------------------
// GEMINI
// ---------------------------------------------------------------------------

/**
 * Google Gemini `generateContent`.
 *
 * Structured output: setting `responseMimeType: "application/json"` together
 * with a `responseSchema` makes the model emit schema-conforming JSON with no
 * markdown fences and no preamble. That is much more reliable than asking
 * nicely in the prompt, though we still parse defensively below.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/structured-output
 */
async function callGemini({ system, user, schema, maxTokens, temperature }) {
  if (!GEMINI_API_KEY) {
    throw llmError(
      "missing_api_key",
      "GEMINI_API_KEY is not set — see .env.example for signup instructions.",
      false,
    );
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL,
  )}:generateContent`;

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
      ...(schema ? { responseSchema: schema } : {}),
    },
    // Scheduling and fatigue language ("exhausted", "critical", "trauma") can
    // trip default safety thresholds on an occupational-health corpus. Relax to
    // the documented high-harm-only threshold rather than fighting false
    // positives mid-demo.
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Header auth rather than ?key= in the query string, so the key cannot
      // end up in a proxy or server access log.
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await safeText(response);
    throw llmError(
      `gemini_http_${response.status}`,
      `Gemini returned ${response.status}: ${truncate(detail, 300)}`,
      // 429 = quota, 5xx = transient. Both worth retrying. 4xx = our bug.
      response.status === 429 || response.status >= 500,
    );
  }

  const json = await response.json();

  const candidate = json?.candidates?.[0];
  if (!candidate) {
    // A blocked prompt returns no candidates but does include a reason.
    const blockReason = json?.promptFeedback?.blockReason;
    throw llmError(
      blockReason ? "gemini_blocked" : "gemini_empty_response",
      blockReason
        ? `Gemini blocked the prompt (${blockReason}).`
        : "Gemini returned no candidates.",
      false,
    );
  }

  if (candidate.finishReason === "MAX_TOKENS") {
    throw llmError("gemini_truncated", "Gemini hit the output token limit.", true);
  }

  const text = candidate.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    throw llmError("gemini_empty_text", "Gemini returned an empty response body.", true);
  }
  return text;
}

// ---------------------------------------------------------------------------
// ANTHROPIC / CLAUDE
// ---------------------------------------------------------------------------

/**
 * Claude via the official SDK. Optional dependency — imported dynamically so
 * the app runs fine when it isn't installed and this provider isn't selected.
 *
 * We enforce JSON by instruction + tolerant parsing rather than by the API's
 * structured-output parameter, purely to keep this adapter simple and stable
 * across SDK versions. If you standardise on Claude, the better approach is
 * `output_config.format` / `client.messages.parse()`.
 */
async function callAnthropic({ system, user, schema, maxTokens, temperature }) {
  if (!ANTHROPIC_API_KEY) {
    throw llmError(
      "missing_api_key",
      "ANTHROPIC_API_KEY is not set — see .env.example for signup instructions.",
      false,
    );
  }

  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    throw llmError(
      "sdk_not_installed",
      "LLM_PROVIDER=anthropic requires the optional dependency: npm install @anthropic-ai/sdk",
      false,
    );
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 0 });

  const schemaHint = schema
    ? `\n\nReturn JSON matching exactly this shape:\n${JSON.stringify(schema, null, 2)}`
    : "";

  try {
    const message = await client.messages.create(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system: `${system}\n\nReturn ONLY valid JSON. No markdown fences, no preamble, no commentary.${schemaHint}`,
        messages: [{ role: "user", content: user }],
        // Low effort: these are short structured scoring calls, not open-ended
        // reasoning, so deep thinking buys nothing and costs latency.
        output_config: { effort: "low" },
      },
      { timeout: LLM_TIMEOUT_MS },
    );

    if (message.stop_reason === "refusal") {
      throw llmError("anthropic_refusal", "Claude declined to answer this request.", false);
    }

    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  } catch (error) {
    if (error?.code) throw error; // already one of ours
    const status = error?.status;
    throw llmError(
      `anthropic_${status ?? "error"}`,
      String(error?.message ?? error),
      status === 429 || (status >= 500 && status < 600),
    );
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function llmError(code, message, retryable) {
  const e = new Error(message);
  e.code = code;
  e.retryable = retryable;
  return e;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw llmError("timeout", `LLM request exceeded ${LLM_TIMEOUT_MS}ms.`, true);
    }
    throw llmError("network_error", String(error?.message ?? error), true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tolerant JSON extraction. Even with responseMimeType set, models occasionally
 * wrap output in ```json fences or add a stray sentence. Try the cheap parse
 * first, then progressively more forgiving strategies.
 */
export function extractJson(text) {
  if (!text) return null;
  const trimmed = String(text).trim();

  // 1. Clean parse.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* fall through */
  }

  // 2. Strip markdown code fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through */
    }
  }

  // 3. Grab the outermost balanced {...} and parse that.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through */
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "<no body>";
  }
}

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n)}...` : str;
}

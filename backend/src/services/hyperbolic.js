const API_BASE = 'https://api.hyperbolic.xyz/v1';
const API_KEY = process.env.HYPERBOLIC_API_KEY;
const CHAT_MODEL = process.env.HYPERBOLIC_CHAT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct';

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };
}

export function isConfigured() {
  return Boolean(API_KEY);
}

export async function chatCompletion(messages, opts = {}) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.3,
      top_p: opts.topP ?? 0.9,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hyperbolic chat error ${res.status}: ${body}`);
  }
  const json = await res.json();
  return json.choices[0].message.content;
}

// Procura — Groq proxy
// Keeps GROQ_API_KEY server-side (set it in Netlify > Site settings > Environment variables).
// The browser never sees the key. Forces JSON output when asked, and returns just the
// model's text content so the frontend can JSON.parse it.

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const key = process.env.GROQ_API_KEY;
  if (!key) return json(500, { error: "GROQ_API_KEY is not set in Netlify environment variables." });

  let input;
  try { input = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "invalid JSON body" }); }

  const {
    messages,
    temperature = 0.2,
    json: wantJson = true,
    model = "llama-3.3-70b-versatile",
    max_tokens = 2048
  } = input;

  if (!Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: "messages array required" });
  }

  const body = { model, messages, temperature, max_tokens };
  if (wantJson) body.response_format = { type: "json_object" };

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    if (!r.ok) return json(r.status, { error: "groq_error", detail: text.slice(0, 600) });
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content ?? "";
    return json(200, { content });
  } catch (e) {
    return json(502, { error: "fetch_failed", detail: String(e) });
  }
};

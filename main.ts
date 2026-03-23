Deno.serve(async (req) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  const url = new URL(req.url);

  // ── Health check ───────────────────────────────────────────
  if (url.pathname === "/health") {
    const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    console.log("[health] key present:", key.length > 0);
    return new Response(JSON.stringify({
      ok: true,
      keyPresent: key.length > 0,
      keyPrefix: key.length > 6 ? key.slice(0, 6) + "..." : "(empty)",
    }), { headers });
  }

  // ── Kitspace parts search proxy ────────────────────────────
  // Proxied here to avoid CORS issues in the browser
  if (url.pathname === "/search" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    if (!q) return new Response(JSON.stringify([]), { headers });
    console.log(`[search] proxying Kitspace query: "${q}"`);
    try {
      const kitUrl = `https://api.kitspace.org/v1/1_part_searches?q=${encodeURIComponent(q)}&limit=8`;
      const resp = await fetch(kitUrl, {
        signal: AbortSignal.timeout(6000),
        headers: { "Accept": "application/json" },
      });
      if (!resp.ok) {
        console.warn(`[search] Kitspace returned ${resp.status}`);
        return new Response(JSON.stringify([]), { status: 200, headers });
      }
      const data = await resp.json();
      console.log(`[search] Kitspace returned ${Array.isArray(data) ? data.length : "?"} results`);
      return new Response(JSON.stringify(data), { headers });
    } catch (err) {
      console.warn(`[search] Kitspace fetch failed: ${(err as Error).message}`);
      return new Response(JSON.stringify([]), { status: 200, headers });
    }
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();

    // ── Echo mode ──────────────────────────────────────────────
    if (body.echo) {
      console.log("[echo] echo request received");
      return new Response(JSON.stringify({
        content: [{ type: "text", text: '{"label":"Echo Test","shortLabel":"TEST","width":60,"height":50,"description":"Proxy echo test","color":"#1a2e1a","category":"generic","pins":[{"x":0,"y":10,"name":"VCC","type":"power_in"},{"x":0,"y":30,"name":"GND","type":"gnd"}],"defaults":{"vcc":5},"props":["vcc"],"units":{"vcc":"V"},"thermalCoeff":0.05,"physics":{"type":"digital","vcc_nom":5,"icc_active_ma":10,"temp_max_c":85},"simulateBehavior":"standard_digital","spiceParams":{}}' }],
      }), { headers });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (!apiKey) {
      console.error("[error] ANTHROPIC_API_KEY is not set");
      return new Response(JSON.stringify({
        error: "ANTHROPIC_API_KEY env var not set on Deno Deploy",
      }), { status: 500, headers });
    }

    const firstMsg = body.messages?.[0]?.content ?? "";
    const partMatch = firstMsg.match(/PART NUMBER:\s*(\S+)/);
    const partNumber = partMatch?.[1] ?? "unknown";
    console.log(`[ingest] request for part: ${partNumber}`);

    const orResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://siliconejs.app",
        "X-Title": "Silicon Lab",
      },
      body: JSON.stringify({
        model: "mistralai/mistral-7b-instruct:free",
        messages: body.messages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: 0.2,
        max_tokens: 1200,
      }),
    });

    const data = await orResp.json();
    console.log(`[openrouter] status: ${orResp.status}, model: ${data.model ?? "?"}`);

    if (!orResp.ok) {
      console.error("[openrouter] error body:", JSON.stringify(data));
      return new Response(JSON.stringify({
        error: `OpenRouter ${orResp.status}: ${typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? data)}`,
      }), { status: 502, headers });
    }

    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) {
      console.error("[openrouter] empty content, full response:", JSON.stringify(data));
      return new Response(JSON.stringify({
        error: "OpenRouter returned empty content",
      }), { status: 502, headers });
    }

    console.log(`[ingest] success for ${partNumber}, response length: ${text.length} chars`);
    return new Response(JSON.stringify({
      content: [{ type: "text", text }],
    }), { headers });

  } catch (err) {
    console.error("[error] unhandled exception:", (err as Error).message);
    return new Response(JSON.stringify({
      error: (err as Error).message,
    }), { status: 500, headers });
  }
});

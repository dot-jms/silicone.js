Deno.serve(async (req) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── Health check endpoint ──────────────────────────────────
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    const key = Deno.env.get("OPENROUTER_API_KEY") ?? "";
    return new Response(JSON.stringify({
      ok: true,
      keyPresent: key.length > 0,
      keyPrefix: key.length > 6 ? key.slice(0, 6) + "..." : "(empty)",
    }), { headers });
  }

  try {
    const body = await req.json();

    // ── Debug: echo mode — POST {"echo": true} to test proxy ──
    if (body.echo) {
      return new Response(JSON.stringify({
        content: [{ type: "text", text: '{"label":"Echo Test","shortLabel":"TEST","width":60,"height":50,"description":"Proxy echo test","color":"#1a2e1a","category":"generic","pins":[{"x":0,"y":10,"name":"VCC","type":"power_in"},{"x":0,"y":30,"name":"GND","type":"gnd"}],"defaults":{"vcc":5},"props":["vcc"],"units":{"vcc":"V"},"thermalCoeff":0.05,"physics":{"type":"digital","vcc_nom":5,"icc_active_ma":10,"temp_max_c":85},"simulateBehavior":"standard_digital","spiceParams":{}}' }],
        _debug: { mode: "echo", timestamp: new Date().toISOString() }
      }), { headers });
    }

    const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
    if (!apiKey) {
      return new Response(JSON.stringify({
        error: "OPENROUTER_API_KEY env var not set on Deno Deploy",
        _debug: { keyMissing: true }
      }), { status: 500, headers });
    }

    const orResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://siliconejs.app",
        "X-Title": "Silicon Lab",
      },
      body: JSON.stringify({
        model: "google/gemini-flash-1.5",
        messages: body.messages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: 0.2,
        max_tokens: 1200,
      }),
    });

    const data = await orResp.json();

    if (!orResp.ok) {
      return new Response(JSON.stringify({
        error: `OpenRouter ${orResp.status}: ${data?.error?.message ?? JSON.stringify(data)}`,
        _debug: { orStatus: orResp.status, orBody: data }
      }), { status: 502, headers });
    }

    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) {
      return new Response(JSON.stringify({
        error: "OpenRouter returned empty content",
        _debug: { orResponse: data }
      }), { status: 502, headers });
    }

    return new Response(JSON.stringify({
      content: [{ type: "text", text }],
      _debug: {
        model: data.model,
        usage: data.usage,
        finishReason: data.choices?.[0]?.finish_reason,
      }
    }), { headers });

  } catch (err) {
    return new Response(JSON.stringify({
      error: (err as Error).message,
      _debug: { stack: (err as Error).stack?.slice(0, 300) }
    }), { status: 500, headers });
  }
});

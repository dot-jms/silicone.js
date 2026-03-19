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

  try {
    const body = await req.json();
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("ANTHROPIC_API_KEY") ?? ""}`,
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.1-8b-instruct:free",
        messages: body.messages.map((m: {role: string, content: string}) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });
    const data = await response.json();
    // Reformat to match Anthropic response shape that component-ingestor expects
    const text = data.choices?.[0]?.message?.content ?? "{}";
    return new Response(JSON.stringify({
      content: [{ type: "text", text }]
    }), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers,
    });
  }
});

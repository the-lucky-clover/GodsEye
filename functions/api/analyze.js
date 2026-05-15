/**
 * /api/analyze — AI-powered airspace analysis using Workers AI.
 *
 * Accepts a POST request with a JSON body:
 *   { aircraft_count: number, region: string, anomalies: string }
 *
 * Returns:
 *   { summary: string }  — a 2-sentence intelligence-style assessment
 *
 * Binding (configured in wrangler.toml):
 *   AI — Workers AI (bound to the free-tier @cf/meta/llama-3.1-8b-instruct model)
 *
 * Free-tier note: Workers AI is granted a daily "neurons" budget. Each
 * inference call costs roughly 100–500 neurons. The endpoint is intentionally
 * gated behind a user action (the ANALYZE button) and never called
 * automatically so the budget is not exhausted by background polling.
 */

export async function onRequest(ctx) {
  if (ctx.request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  if (!ctx.env.AI) {
    return Response.json(
      { summary: 'AI analysis is unavailable — the Workers AI binding is not configured.' },
      { status: 503 }
    )
  }

  let body
  try {
    body = await ctx.request.json()
  } catch {
    return new Response('Invalid JSON body', { status: 400 })
  }

  const { aircraft_count = 0, region = 'unknown region', anomalies = 'none' } = body

  try {
    const result = await ctx.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content:
            'You are a concise military intelligence analyst. Respond with exactly two sentences. ' +
            'Use a clipped, professional tone. Do not use markdown formatting.',
        },
        {
          role: 'user',
          content:
            `Airspace snapshot: ${aircraft_count} aircraft tracked over ${region}. ` +
            `Notable observations: ${anomalies}. ` +
            'Provide a two-sentence tactical assessment.',
        },
      ],
      max_tokens: 120,
    })

    return Response.json({ summary: result.response })
  } catch (e) {
    console.error('[Analyze] Workers AI error:', e.message)
    return Response.json(
      { summary: `Analysis failed: ${e.message}` },
      { status: 502 }
    )
  }
}

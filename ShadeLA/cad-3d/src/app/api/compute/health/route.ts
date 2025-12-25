import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const baseUrl = process.env.COMPUTE_URL;
  const apiKey = process.env.COMPUTE_KEY;

  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { ok: false, reason: "Missing COMPUTE_URL or COMPUTE_KEY env" },
      { status: 400 }
    );
  }

  try {
    const r = await fetch(new URL("/version", baseUrl).toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
      // Rhino Compute sometimes keeps connections; set a short timeout via AbortController
      signal: AbortSignal.timeout(5000),
    });
    const txt = await r.text();
    return NextResponse.json({ ok: r.ok, status: r.status, body: txt.slice(0, 2000) });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 502 });
  }
}

import { NextRequest } from "next/server";

export const runtime = "nodejs";

function parseBboxParam(param: string | null): [number, number, number, number] | null {
  if (!param) return null;
  const parts = param.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4) return null;
  const [w, s, e, n] = parts;
  if (![w, s, e, n].every((v) => Number.isFinite(v))) return null;
  return [w, s, e, n];
}

export async function GET(req: NextRequest) {
  const bbox = parseBboxParam(req.nextUrl.searchParams.get("bbox"));
  if (!bbox) {
    return new Response(JSON.stringify({ error: "bbox required" }), { status: 400 });
  }

  const r = await fetch(new URL(`/api/export-3dm?bbox=${encodeURIComponent(bbox.join(","))}`, req.url).toString(), {
    method: "GET",
  });

  return new Response(await r.arrayBuffer(), {
    status: r.status,
    headers: {
      "Content-Type": r.headers.get("Content-Type") || "application/octet-stream",
      "Content-Disposition": r.headers.get("Content-Disposition") || "attachment; filename=export_3dm.3dm",
    },
  });
}

// Simplified: always proxy to local /api/export-3dm.
// No external Compute dependency, no compute_unavailable errors.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const bbox = body?.bbox as [number, number, number, number] | undefined;
    if (!bbox) {
      return new Response(JSON.stringify({ error: "bbox required" }), { status: 400 });
    }

    const r = await fetch(new URL("/api/export-3dm", req.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bbox }),
    });

    return new Response(await r.arrayBuffer(), {
      status: r.status,
      headers: {
        "Content-Type": r.headers.get("Content-Type") || "application/octet-stream",
        "Content-Disposition":
          r.headers.get("Content-Disposition") || "attachment; filename=export_3dm.3dm",
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err?.message || err) }), {
      status: 500,
    });
  }
}

import { NextRequest } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

// GeoJSON export from cb_2020_06_tract_500k.shp
const GEOJSON_PATH = path.join(process.cwd(), "cb_2020_06_tract_500k.json");

let cachedGeojson: any | null = null;

async function loadGeojson() {
  if (cachedGeojson) return cachedGeojson;
  const raw = await fs.readFile(GEOJSON_PATH, "utf8");
  cachedGeojson = JSON.parse(raw);
  return cachedGeojson;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawGeoid = searchParams.get("geoid");
    if (!rawGeoid) {
      return new Response(JSON.stringify({ error: "geoid_required" }), { status: 400 });
    }

    // Normalize GEOID to 11 chars with leading zeros to match GeoJSON
    const geoid = rawGeoid.toString().padStart(11, "0");

    const gj = await loadGeojson();
    const features: any[] = gj.features || [];
    const feature = features.find((f) => f?.properties?.GEOID === geoid);

    if (!feature) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }

    return new Response(JSON.stringify(feature), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err?.message || err) }), {
      status: 500,
    });
  }
}

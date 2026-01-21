import { NextRequest } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

const PLACES_PATH = path.join(process.cwd(), "cb_2020_06_place_500k.json");

interface PlaceItem {
  GEOID: string;
  NAME: string;
}

let cachedPlacesRaw: any | null = null;
let cachedPlacesList: PlaceItem[] | null = null;

async function loadPlacesRaw(): Promise<any> {
  if (cachedPlacesRaw) return cachedPlacesRaw;
  const raw = await fs.readFile(PLACES_PATH, "utf8");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  cachedPlacesRaw = data;
  return data;
}

// Approximate Los Angeles County bounding box (lat/lon)
const LA_BBOX = {
  west: -119.2,
  south: 33.4,
  east: -117.6,
  north: 34.9,
};

function geomCentroid(geom: any): { lon: number; lat: number } | null {
  if (!geom || !geom.type || !geom.coordinates) return null;
  const coords: number[][][] = [];
  if (geom.type === "Polygon") {
    coords.push(geom.coordinates[0]);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      if (poly[0]) coords.push(poly[0]);
    }
  } else {
    return null;
  }
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  for (const ring of coords) {
    for (const [lon, lat] of ring) {
      sumLon += lon;
      sumLat += lat;
      count++;
    }
  }
  if (!count) return null;
  return { lon: sumLon / count, lat: sumLat / count };
}

function isInLaCountyApprox(geom: any): boolean {
  const c = geomCentroid(geom);
  if (!c) return false;
  return (
    c.lon >= LA_BBOX.west &&
    c.lon <= LA_BBOX.east &&
    c.lat >= LA_BBOX.south &&
    c.lat <= LA_BBOX.north
  );
}

async function loadPlacesList(): Promise<PlaceItem[]> {
  if (cachedPlacesList) return cachedPlacesList;
  const data = await loadPlacesRaw();
  const features: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.features)
    ? data.features
    : [];

  const items: PlaceItem[] = [];
  for (const f of features) {
    const geom = (f && f.geometry) || null;
    if (!isInLaCountyApprox(geom)) continue;
    const props = (f && (f.properties || f)) || {};
    const name = String(props.NAME || props.name || "").trim();
    if (!name) continue;
    const geoid = String(props.GEOID || props.geoid || name).trim();
    items.push({ GEOID: geoid, NAME: name });
  }

  cachedPlacesList = items;
  return items;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const geoid = searchParams.get("geoid");

    const data = await loadPlacesRaw();
    const features: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.features)
      ? data.features
      : [];

    if (!geoid) {
      const items = await loadPlacesList();
      return new Response(JSON.stringify(items), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const feature = features.find((f) => {
      const geom = (f && f.geometry) || null;
      if (!isInLaCountyApprox(geom)) return false;
      const props = (f && (f.properties || f)) || {};
      const name = String(props.NAME || props.name || "").trim();
      const id = String(props.GEOID || props.geoid || name).trim();
      return id === geoid;
    });

    if (!feature) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }

    return new Response(JSON.stringify(feature), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: "server_error", detail: String(err?.message || err) }),
      { status: 500 }
    );
  }
}

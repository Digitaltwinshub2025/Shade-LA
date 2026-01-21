import { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const bbox = body?.bbox as [number, number, number, number] | undefined; // [w,s,e,n]
    if (!bbox || bbox.length !== 4) {
      return new Response(JSON.stringify({ error: "bbox [w,s,e,n] is required" }), { status: 400 });
    }

    const [w, s, e, n] = bbox;

    // Overpass QL: buildings as ways and relations within bbox
    const query = `
      [out:xml][timeout:25];
      (
        way["building"](${s},${w},${n},${e});
        relation["building"](${s},${w},${n},${e});

        // roads
        way["highway"](${s},${w},${n},${e});

        // green areas / parks
        way["landuse"="grass"](${s},${w},${n},${e});
        way["leisure"="park"](${s},${w},${n},${e});

        // water
        way["natural"="water"](${s},${w},${n},${e});
        way["waterway"="riverbank"](${s},${w},${n},${e});
      );
      (._;>;);
      out body;
    `;

    const endpoints = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass.openstreetmap.ru/api/interpreter",
    ];

    const controller = new AbortController();
    const timeoutMs = 25000;
    let xml: string | null = null;
    let lastError: any = null;
    for (const url of endpoints) {
      try {
        const to = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: new URLSearchParams({ data: query }).toString(),
          signal: controller.signal,
        });
        clearTimeout(to);
        if (resp.ok) {
          xml = await resp.text();
          break;
        } else {
          lastError = `HTTP ${resp.status}`;
        }
      } catch (err) {
        lastError = String(err);
      }
      // brief backoff
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!xml) {
      return new Response(
        JSON.stringify({ error: "overpass_unavailable", detail: lastError || "all endpoints failed" }),
        { status: 502 }
      );
    }

    // Convert to GeoJSON using osmtogeojson
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const osmtogeojson = require("osmtogeojson");
    const { DOMParser } = require("@xmldom/xmldom");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const geojson = osmtogeojson(doc, {
      polygonFeatures: {
        building: true,
        landuse: true,
        leisure: true,
        natural: true,
        waterway: true,
      },
    });

    return new Response(JSON.stringify(geojson), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err?.message || err) }), { status: 500 });
  }
}

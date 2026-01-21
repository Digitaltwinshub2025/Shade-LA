import { NextRequest } from "next/server";
import proj4 from "proj4";
// Using classic dxf-writer (CommonJS)

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

   const r = await fetch(new URL("/api/export-dxf", req.url).toString(), {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ bbox }),
   });

   return new Response(await r.arrayBuffer(), {
     status: r.status,
     headers: {
       "Content-Type": r.headers.get("Content-Type") || "application/dxf",
       "Content-Disposition": r.headers.get("Content-Disposition") || "attachment; filename=export.dxf",
     },
   });
 }

async function fetchDemForBbox(bbox: [number, number, number, number]): Promise<Buffer | null> {
  const [w, s, e, n] = bbox;
  const bboxParam = `${w},${s},${e},${n}`;
  const baseUrl = "https://tnmaccess.nationalmap.gov/api/v1/products";
  const url = `${baseUrl}?f=json&bbox=${encodeURIComponent(
    bboxParam
  )}&bboxSR=4326&prodFormats=${encodeURIComponent("GeoTIFF")}`;

  console.log("[export-dxf] Requesting USGS DEM:", url);
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.error("[export-dxf] USGS TNMAccess request failed:", r.status, r.statusText);
      return null;
    }
    const json: any = await r.json();
    const products: any[] = json?.products || json?.items || [];
    if (!products.length) {
      console.warn("[export-dxf] No products returned for bbox", bbox);
      return null;
    }

    // Prefer DEM products (1/3 arc-second if available), but fall back to any DEM GeoTIFF.
    const isDem = (p: any) => {
      const name = (p?.productName || p?.title || "").toString().toLowerCase();
      return name.includes("dem") || name.includes("digital elevation model");
    };
    const isOneThird = (p: any) => {
      const name = (p?.productName || p?.title || "").toString().toLowerCase();
      return name.includes("1/3") || name.includes("one-third") || name.includes("1/3rd");
    };

    let prod: any | undefined = products.find((p) => isDem(p) && isOneThird(p));
    if (!prod) prod = products.find((p) => isDem(p));
    if (!prod) prod = products[0];
    const downloadUrl: string | undefined = prod.downloadURL || prod.downloadUrl || prod.url;
    if (!downloadUrl) {
      console.warn("[export-dxf] DEM product has no download URL");
      return null;
    }
    console.log("[export-dxf] DEM product:", prod.title || prod.name || "(no title)");
    console.log("[export-dxf] Downloading DEM GeoTIFF:", downloadUrl);
    const demResp = await fetch(downloadUrl);
    if (!demResp.ok) {
      console.error(
        "[export-dxf] Failed to download DEM GeoTIFF:",
        demResp.status,
        demResp.statusText
      );
      return null;
    }
    const buf = Buffer.from(await demResp.arrayBuffer());
    console.log("[export-dxf] DEM GeoTIFF downloaded, size:", buf.length);
    return buf;
  } catch (err) {
    console.error("[export-dxf] DEM fetch failed:", err);
    return null;
  }
}

function utmFromLonLat(lon: number, lat: number) {
  const zone = Math.floor((lon + 180) / 6) + 1;
  const isNorth = lat >= 0;
  const epsg = isNorth ? 32600 + zone : 32700 + zone;
  const def = `+proj=utm +zone=${zone} ${isNorth ? "+north" : "+south"} +datum=WGS84 +units=m +no_defs`;
  return { epsg, def, zone, isNorth };
}

// Meters-to-feet conversion factor for coordinates and elevations
// that were previously treated as meters (UTM, building heights, etc.).
const M2FT = 3.280839895; // 1 m = 3.280839895 ft

// Temporary calibration of DEM elevations to more realistic values (based on a few control points).
// baseSample returns DEM height in meters (~2900–3000 m). Based on measurements in LA we want
// about 100–120 m above sea level, so we use a linear approximation h ≈ a*z + b.
function demToHeightMeters(zMeters: number): number {
  const a = -0.48;
  const b = 1553;
  return a * zMeters + b;
}

function heightFromProps(props: any): number {
  if (!props) return 10;
  const toNum = (v: any): number | undefined => {
    if (v === undefined || v === null) return undefined;
    let s = String(v).trim().toLowerCase();
    if (!s) return undefined;
    s = s.replace(/,/g, ".");
    const ft = 0.3048;
    const inch = 0.0254;
    const cm = 0.01;
    const mm = 0.001;

    // 1) feet-inches patterns like 12'6" or 12' or 12 ft 6 in
    const feetInch = s.match(/^(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')\s*(?:([\d.]+)\s*(?:in|"))?/);
    if (feetInch) {
      const f = parseFloat(feetInch[1]);
      const i = feetInch[2] ? parseFloat(feetInch[2]) : 0;
      if (!isNaN(f) || !isNaN(i)) return f * ft + i * inch;
    }

    // 2) explicit units
    if (/^[-+]?\d+(?:\.\d+)?\s*m$/.test(s)) return parseFloat(s) * 1;
    if (/^[-+]?\d+(?:\.\d+)?\s*cm$/.test(s)) return parseFloat(s) * cm;
    if (/^[-+]?\d+(?:\.\d+)?\s*mm$/.test(s)) return parseFloat(s) * mm;
    if (/^[-+]?\d+(?:\.\d+)?\s*(?:ft|feet|foot)$/.test(s)) return parseFloat(s) * ft;
    if (/^[-+]?\d+(?:\.\d+)?\s*(?:in|\")$/.test(s)) return parseFloat(s) * inch;

    // 3) condensed without space e.g. 30ft, 300cm, 12"
    const m1 = s.match(/^([-+]?\d+(?:\.\d+)?)(m|cm|mm|ft|')$/);
    if (m1) {
      const val = parseFloat(m1[1]);
      const u = m1[2];
      if (!isNaN(val)) {
        if (u === 'm') return val;
        if (u === 'cm') return val * cm;
        if (u === 'mm') return val * mm;
        if (u === 'ft' || u === "'") return val * ft;
      }
    }

    // 4) plain number: assume meters
    const n = parseFloat(s);
    return isNaN(n) ? undefined : n;
  };

  const parseTotalHeight = (): number | undefined => {
    const h = toNum(props.height) ?? toNum(props["building:height"]);
    if (h !== undefined) return h;
    // derive from levels if height not present
    const lv = toNum(props.levels) ?? toNum(props["building:levels"]);
    const roofH = toNum(props["roof:height"]) ?? 0;
    if (lv !== undefined && lv > 0) return lv * 3 + roofH;
    return undefined;
  };

  let h = parseTotalHeight();
  if (h === undefined) h = 10;

  // account for min_height if provided (total extrusion)
  const minH = toNum(props.min_height) ?? toNum(props["building:min_height"]) ?? 0;
  if (!isNaN(minH) && minH > 0 && h > minH) h = h - minH;
  return h;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const bbox = body?.bbox as [number, number, number, number] | undefined; // [w,s,e,n]
    if (!bbox) return new Response(JSON.stringify({ error: "bbox required" }), { status: 400 });
    const [w, s, e, n] = bbox;

    // Step 1: attempt to fetch USGS DEM for this bbox (logging only, no behavior change yet)
    let demInfo = "none";
    let demBuf: Buffer | null = null;
    // baseSample: DEM height above min DEM, without scaling
    let baseSample = (lon: number, lat: number): number => 0;
    // sampleTerrain: terrain height (with Z exaggeration)
    let sampleTerrain = (lon: number, lat: number): number => 0;
    // sampleBuilding: height under buildings (realistic, without extra scaling)
    let sampleBuilding = (lon: number, lat: number): number => 0;
    // Global vertical scale (in feet) for terrain and buildings
    let terrainScaleFeet = 1.5;
    try {
      demBuf = await fetchDemForBbox(bbox);
      if (demBuf) {
        demInfo = `downloaded (${demBuf.length} bytes)`;
      } else {
        demInfo = "not_available";
      }
    } catch (e) {
      demInfo = `error: ${String((e as any)?.message || e)}`;
    }
    console.log("[export-dxf] DEM status for bbox", bbox, "=>", demInfo);

    // Step 2: if DEM was downloaded, parse it via geotiff and log a few sample elevations
    if (demBuf) {
      try {
        const { fromArrayBuffer } = await import("geotiff");
        const ab = demBuf.buffer.slice(
          demBuf.byteOffset,
          demBuf.byteOffset + demBuf.byteLength
        ) as ArrayBuffer;
        const tiff = await fromArrayBuffer(ab);
        const image = await tiff.getImage();
        const width = image.getWidth();
        const height = image.getHeight();
        const rasters = (await image.readRasters({ interleave: true })) as Float32Array | number[];
        const elevation = rasters as any;

        const demBbox = image.getBoundingBox(); // [minX, minY, maxX, maxY] in dataset CRS, usually lon/lat
        const minX = demBbox[0];
        const minY = demBbox[1];
        const maxX = demBbox[2];
        const maxY = demBbox[3];

        const buildingsZEx = (() => {
          const src = (body && (body as any).buildingsZEx) != null
            ? (body as any).buildingsZEx
            : process.env.BUILDINGS_Z_EXAGGERATION;
          const v = Number(src);
          return isNaN(v) || v <= 0 ? 1 : v;
        })();

        const buildingsZOffset = (() => {
          const src = (body && (body as any).buildingsZOffset) != null
            ? (body as any).buildingsZOffset
            : process.env.BUILDINGS_Z_OFFSET;
          const v = Number(src);
          return isNaN(v) ? 0 : v;
        })();

        // DEM vertical scale. In practice USGS DEM is already in meters,
        // so we keep scale = 1 to avoid inflating heights with an extra factor.
        const demVerticalScale = 1;

        // Maximum terrain height (meters).
        // If not provided (<=0 or NaN) — do not clamp; use the full DEM.
        const maxTerrainHeightMeters = (() => {
          const src = (body && (body as any).terrainMaxHeight) != null
            ? (body as any).terrainMaxHeight
            : process.env.TERRAIN_MAX_HEIGHT;
          const v = Number(src);
          return isNaN(v) || v <= 0 ? Number.POSITIVE_INFINITY : v;
        })();

        // Bilinear interpolation of DEM from raw GeoTIFF values;
        // if maxTerrainHeightMeters is finite, additionally clamp heights from above.
        baseSample = (lon: number, lat: number): number => {
          if (maxX === minX || maxY === minY) return 0;
          const fx = (lon - minX) / (maxX - minX);
          const fy = (lat - minY) / (maxY - minY);
          const x = fx * (width - 1);
          const y = fy * (height - 1);
          const ix = Math.floor(x);
          const iy = Math.floor(y);
          const tx = x - ix;
          const ty = y - iy;
          const idx = (xi: number, yi: number) => {
            const cx = Math.max(0, Math.min(width - 1, xi));
            const cy = Math.max(0, Math.min(height - 1, yi));
            return cy * width + cx;
          };
          const z00 = Number(elevation[idx(ix,     iy    )] ?? 0);
          const z10 = Number(elevation[idx(ix + 1, iy    )] ?? 0);
          const z01 = Number(elevation[idx(ix,     iy + 1)] ?? 0);
          const z11 = Number(elevation[idx(ix + 1, iy + 1)] ?? 0);
          const zRaw =
            z00 * (1 - tx) * (1 - ty) +
            z10 * tx * (1 - ty) +
            z01 * (1 - tx) * ty +
            z11 * tx * ty;
          let z = zRaw * demVerticalScale;
          let zClamped = z;
          if (!Number.isFinite(zClamped)) zClamped = 0;
          if (Number.isFinite(maxTerrainHeightMeters) && zClamped > maxTerrainHeightMeters) {
            zClamped = maxTerrainHeightMeters;
          }
          return zClamped;
        };

        // Global vertical scale in feet: allows slightly boosting relief
        // without breaking the alignment of buildings and roads with Terrain_3D.
        terrainScaleFeet = (() => {
          const src = (body && (body as any).terrainScaleFeet) != null
            ? (body as any).terrainScaleFeet
            : process.env.TERRAIN_SCALE_FEET;
          const v = Number(src);
          return isNaN(v) || v <= 0 ? 1.5 : v; // slight exaggeration by default
        })();

        const clearanceFt = (() => {
          const src = (body && (body as any).buildingsClearanceFt) != null
            ? (body as any).buildingsClearanceFt
            : process.env.BUILDINGS_CLEARANCE_FT;
          const v = Number(src);
          return isNaN(v) ? 0.5 : Math.max(0, v);
        })();

        // ONE height formula for everything: Terrain_3D, buildings, and roads.
        // h_dem -> demToHeightMeters -> feet. Buildings get a small clearance above terrain.

        const heightFeetFromDem = (lon: number, lat: number): number => {
          const zRaw = baseSample(lon, lat);
          const zMeters = demToHeightMeters(zRaw);
          const zFeet = zMeters * M2FT * terrainScaleFeet;
          return Number.isFinite(zFeet) ? zFeet : 0;
        };

        sampleTerrain = (lon: number, lat: number): number => {
          return heightFeetFromDem(lon, lat);
        };

        sampleBuilding = (lon: number, lat: number): number => {
          return heightFeetFromDem(lon, lat) + clearanceFt;
        };

        const samples = [
          { name: "center", lon: (w + e) / 2, lat: (s + n) / 2 },
          { name: "southWest", lon: w, lat: s },
          { name: "northEast", lon: e, lat: n },
        ].map((p) => ({ ...p, z: sampleTerrain(p.lon, p.lat) }));

        // DEBUG: sample DEM at user-marked peak points and around them
        const dLat = 0.0005; // ~55 m
        const dLon = 0.0005;
        const peakPoints = [
          { name: "p1_cross", lat: 34.123551, lon: -118.375425 },
          { name: "p2_top", lat: 34.123789, lon: -118.375437 },
          { name: "p3_summit", lat: 34.124242, lon: -118.375160 },
        ];
        const peaks = peakPoints.flatMap((p) => {
          const base = { name: p.name, lon: p.lon, lat: p.lat };
          const around = [
            { name: p.name + "_n", lon: p.lon, lat: p.lat + dLat },
            { name: p.name + "_s", lon: p.lon, lat: p.lat - dLat },
            { name: p.name + "_e", lon: p.lon + dLon, lat: p.lat },
            { name: p.name + "_w", lon: p.lon - dLon, lat: p.lat },
          ];
          return [base, ...around];
        }).map((p) => ({
          ...p,
          zTerrain: sampleTerrain(p.lon, p.lat),
          zBase: baseSample(p.lon, p.lat),
        }));

        console.log(
          "[export-dxf] DEM parsed:",
          { width, height, demBbox, samples, peaks }
        );
      } catch (err) {
        console.error("[export-dxf] DEM parse/sample failed:", err);
      }
    }

    // fetch OSM (buildings + roads + parks + water)
    const query = `
      [out:xml][timeout:30];
      (
        way["building"](${s},${w},${n},${e});
        relation["building"](${s},${w},${n},${e});
        way["highway"](${s},${w},${n},${e});
        way["leisure"="park"](${s},${w},${n},${e});
        way["landuse"~"grass|forest"](${s},${w},${n},${e});
        way["natural"~"wood|water"](${s},${w},${n},${e});
        way["waterway"](${s},${w},${n},${e});
        relation["leisure"="park"](${s},${w},${n},${e});
        relation["natural"="water"](${s},${w},${n},${e});
      );
      (._;>;);
      out body;
    `;
    const endpoints = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass.openstreetmap.ru/api/interpreter",
    ];
    let xml: string | null = null;
    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: new URLSearchParams({ data: query }).toString(),
        });
        if (resp.ok) { xml = await resp.text(); break; }
      } catch {}
    }
    if (!xml) return new Response(JSON.stringify({ error: "overpass_unavailable" }), { status: 502 });

    const osmtogeojson = require("osmtogeojson");
    const { DOMParser } = require("@xmldom/xmldom");
    const xmlDoc = new DOMParser().parseFromString(xml, "text/xml");
    const gj = osmtogeojson(xmlDoc, { polygonFeatures: { building: true } });

    const lon0 = (w + e) / 2;
    const lat0 = (s + n) / 2;
    const utm = utmFromLonLat(lon0, lat0);
    const toUtm = proj4("WGS84", utm.def);
    const toLonLat = proj4(utm.def, "WGS84");
    const originUtm = toUtm.forward([lon0, lat0]);

    // Horizontal scaling along the local Y axis (optional, 3D only)
    const horizontalScaleY = (() => {
      const src = (body && (body as any).horizontalScaleY) != null
        ? (body as any).horizontalScaleY
        : process.env.HORIZONTAL_SCALE_Y;
      const v = Number(src);
      return isNaN(v) || v === 0 ? 1 : v;
    })();

    // Prepare DXF (2D plan MVP)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Drawing = require("dxf-writer");
    const dxf = new Drawing();
    dxf.setUnits("Feet");

    // Note: dxf-writer does not expose a comment/note API; skipping metadata embedding for now.

    // Layers (2D plan): buildings are gray, roads are black
    dxf.addLayer("Buildings_Footprints", Drawing.ACI.GRAY, "CONTINUOUS");
    dxf.addLayer("Roads_Motorway", Drawing.ACI.BLACK, "CONTINUOUS");
    dxf.addLayer("Roads_Primary", Drawing.ACI.BLACK, "CONTINUOUS");
    dxf.addLayer("Roads_Secondary", Drawing.ACI.BLACK, "CONTINUOUS");
    dxf.addLayer("Roads_Tertiary", Drawing.ACI.BLACK, "CONTINUOUS");
    dxf.addLayer("Roads_Residential", Drawing.ACI.BLACK, "CONTINUOUS");
    dxf.addLayer("Roads_Service", Drawing.ACI.BLACK, "DASHED");
    dxf.addLayer("Roads_Footway", Drawing.ACI.BLACK, "DASHED");
    dxf.addLayer("Roads_Path", Drawing.ACI.BLACK, "DASHED");
    dxf.addLayer("Roads_Track", Drawing.ACI.BLACK, "DASHED");
    dxf.addLayer("Roads_Cycleway", Drawing.ACI.BLACK, "CONTINUOUS");
    dxf.addLayer("Roads_Other", Drawing.ACI.BLACK, "CONTINUOUS");
    dxf.addLayer("Parks", Drawing.ACI.GREEN, "CONTINUOUS");
    dxf.addLayer("Water", Drawing.ACI.CYAN, "CONTINUOUS");
    dxf.addLayer("StreetNames", Drawing.ACI.RED, "CONTINUOUS");

    // Helpers
    const toLocal = (lon: number, lat: number) => {
      const [x, y] = toUtm.forward([lon, lat]);
      return [
        (x - originUtm[0]) * M2FT,
        (y - originUtm[1]) * M2FT,
      ] as [number, number];
    };

    const features = gj.features || [];
    // Buildings footprints
    dxf.setActiveLayer("Buildings_Footprints");
    for (const f of features) {
      if (!f.geometry) continue;
      if (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") {
        if (!(f.properties && (f.properties.building || f.properties["building:part"])) ) continue;
        const coordsAny: any = f.geometry.coordinates;
        const polys: any[] = f.geometry.type === "Polygon" ? [coordsAny] : coordsAny;
        for (const poly of polys) {
          const outer: number[][] = poly[0];
          const pts = outer.map((p)=>{ const [x,y]=toUtm.forward([p[0],p[1]]); return [(x - originUtm[0]) * M2FT, (y - originUtm[1]) * M2FT] as [number, number]; });
          dxf.drawPolyline(pts, true);
        }
      }
    }

    // Helper to choose road layer by highway type
    const roadLayer = (t: string | undefined) => {
      if (!t) return "Roads_Other";
      const v = String(t).toLowerCase();
      if (v === "motorway" || v === "trunk") return "Roads_Motorway";
      if (v === "primary") return "Roads_Primary";
      if (v === "secondary") return "Roads_Secondary";
      if (v === "tertiary") return "Roads_Tertiary";
      if (v === "residential" || v === "unclassified" || v === "living_street") return "Roads_Residential";
      if (v === "service") return "Roads_Service";
      if (v === "footway" || v === "steps") return "Roads_Footway";
      if (v === "path" || v === "bridleway") return "Roads_Path";
      if (v === "track") return "Roads_Track";
      if (v === "cycleway") return "Roads_Cycleway";
      return "Roads_Other";
    };

    // Roads as polylines (z=0)
    for (const f of features) {
      if (!f.geometry) continue;
      if (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString") {
        if (!(f.properties && f.properties.highway)) continue;
        const layer = roadLayer(f.properties.highway);
        dxf.setActiveLayer(layer);
        if (f.geometry.type === "LineString") {
          const pts = (f.geometry.coordinates as number[][]).map(([lon,lat])=>{ const [x,y]=toUtm.forward([lon,lat]); return [(x - originUtm[0]) * M2FT, (y - originUtm[1]) * M2FT] as [number, number]; });
          if (pts.length>=2) dxf.drawPolyline(pts, false);
        } else {
          for (const line of f.geometry.coordinates as number[][][]) {
            const pts = line.map(([lon,lat])=>{ const [x,y]=toUtm.forward([lon,lat]); return [(x - originUtm[0]) * M2FT, (y - originUtm[1]) * M2FT] as [number, number]; });
            if (pts.length>=2) dxf.drawPolyline(pts, false);
          }
        }
      }
    }

    // Waterways (e.g., canals) as polylines on Water layer
    dxf.setActiveLayer("Water");
    for (const f of features) {
      if (!f.geometry) continue;
      if (!(f.properties && f.properties.waterway)) continue;
      if (f.geometry.type === "LineString") {
        const pts = (f.geometry.coordinates as number[][]).map(([lon,lat])=>{ const [x,y]=toUtm.forward([lon,lat]); return [(x - originUtm[0]) * M2FT, (y - originUtm[1]) * M2FT] as [number, number]; });
        if (pts.length>=2) dxf.drawPolyline(pts, false);
      } else if (f.geometry.type === "MultiLineString") {
        for (const line of f.geometry.coordinates as number[][][]) {
          const pts = line.map(([lon,lat])=>{ const [x,y]=toUtm.forward([lon,lat]); return [(x - originUtm[0]) * M2FT, (y - originUtm[1]) * M2FT] as [number, number]; });
          if (pts.length>=2) dxf.drawPolyline(pts, false);
        }
      }
    }

    // Street name labels (midpoint of lines)
    dxf.setActiveLayer("StreetNames");
    for (const f of features) {
      if (!f.geometry) continue;
      if (!(f.properties && f.properties.highway && f.properties.name)) continue;
      const name = String(f.properties.name);
      if (f.geometry.type === "LineString") {
        const coords = f.geometry.coordinates as number[][];
        if (coords.length >= 2) {
          const mid = coords[Math.floor(coords.length / 2)];
          const [x,y] = toUtm.forward([mid[0], mid[1]]);
          dxf.drawText((x - originUtm[0]) * M2FT, (y - originUtm[1]) * M2FT, 2.5 * M2FT, 0, name);
        }
      } else if (f.geometry.type === "MultiLineString") {
        const lines = f.geometry.coordinates as number[][][];
        if (lines.length) {
          const line = lines[0];
          if (line.length >= 2) {
            const mid = line[Math.floor(line.length / 2)];
            const [x,y] = toUtm.forward([mid[0], mid[1]]);
            dxf.drawText((x - originUtm[0]) * M2FT, (y - originUtm[1]) * M2FT, 2.5 * M2FT, 0, name);
          }
        }
      }
    }

    // Parks and water as polylines
    const drawPolyLayer = (layer: string, predicate: (p:any)=>boolean) => {
      dxf.setActiveLayer(layer);
      for (const f of features) {
        if (!f.geometry) continue;
        if (!(f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")) continue;
        if (!predicate(f.properties || {})) continue;
        const coordsAny: any = f.geometry.coordinates;
        const polys: any[] = f.geometry.type === "Polygon" ? [coordsAny] : coordsAny;
        for (const poly of polys) {
          const outer: number[][] = poly[0];
          const pts = outer.map((p)=>{ const [x,y]=toUtm.forward([p[0],p[1]]); return [x - originUtm[0], y - originUtm[1]] as [number, number]; });
          dxf.drawPolyline(pts, true);
        }
      }
    };
    drawPolyLayer("Parks", (p)=> p.leisure === "park" || p.landuse === "grass" || p.landuse === "forest" || p.natural === "wood");
    drawPolyLayer("Water", (p)=> p.natural === "water" || p.water === "canal" || (p.waterway === "canal" && (p.area === "yes" || p.area === true)) );

    // Try to produce a pure 3D DXF manually with 3DFACE entities
    try {
      type Face = { p1:[number,number,number]; p2:[number,number,number]; p3:[number,number,number]; p4:[number,number,number]; layer: string };
      const faces: Face[] = [];
      const earcut = (await import("earcut")).default as any;
      const zEx = (()=>{
        const v = Number((body && body.terrainExaggeration)!=null ? body.terrainExaggeration : (process.env.TERRAIN_Z_EXAGGERATION ?? 5));
        return isNaN(v) || v<=0 ? 5 : v; // noticeable, but not insane exaggeration
      })();

      // Temporary calibration of DEM elevations to more realistic values (based on a few control points).
      // baseSample returns DEM height in meters (~2900–3000 m). Based on measurements in LA we want
      // about 100–120 m above sea level, so we use a linear approximation h ≈ a*z + b.
      const demToHeightMeters = (zMeters: number): number => {
        const a = -0.48;
        const b = 1553;
        return a * zMeters + b;
      };

      const gridN = 100;
      const lons: number[] = [];
      const lats: number[] = [];
      for (let i = 0; i <= gridN; i++) {
        lons.push(w + ((e - w) * i) / gridN);
        lats.push(s + ((n - s) * i) / gridN);
      }
      let terrainMinZ = Number.POSITIVE_INFINITY;
      let terrainMaxZ = Number.NEGATIVE_INFINITY;
      for (let iy = 0; iy < gridN; iy++) {
        for (let ix = 0; ix < gridN; ix++) {
          const lon00 = lons[ix];
          const lat00 = lats[iy];
          const lon10 = lons[ix + 1];
          const lat01 = lats[iy + 1];
          const [X00, Y00] = toUtm.forward([lon00, lat00]);
          const [X10, Y10] = toUtm.forward([lon10, lat00]);
          const [X01, Y01] = toUtm.forward([lon00, lat01]);
          const [X11, Y11] = toUtm.forward([lon10, lat01]);

          // Use the same height formula as in sampleTerrain/sampleBuilding:
          // DEM -> demToHeightMeters -> feet * terrainScaleFeet. This keeps Terrain_3D and
          // buildings/roads in the same elevation system and scaled consistently.
          const z00 = demToHeightMeters(baseSample(lon00, lat00)) * M2FT * terrainScaleFeet;
          const z10 = demToHeightMeters(baseSample(lon10, lat00)) * M2FT * terrainScaleFeet;
          const z01 = demToHeightMeters(baseSample(lon00, lat01)) * M2FT * terrainScaleFeet;
          const z11 = demToHeightMeters(baseSample(lon10, lat01)) * M2FT * terrainScaleFeet;

          terrainMinZ = Math.min(terrainMinZ, z00, z10, z01, z11);
          terrainMaxZ = Math.max(terrainMaxZ, z00, z10, z01, z11);
          const v00: [number,number,number] = [
            (X00 - originUtm[0]) * M2FT,
            (Y00 - originUtm[1]) * horizontalScaleY * M2FT,
            z00
          ];
          const v10: [number,number,number] = [
            (X10 - originUtm[0]) * M2FT,
            (Y10 - originUtm[1]) * horizontalScaleY * M2FT,
            z10
          ];
          const v01: [number,number,number] = [
            (X01 - originUtm[0]) * M2FT,
            (Y01 - originUtm[1]) * horizontalScaleY * M2FT,
            z01
          ];
          const v11: [number,number,number] = [
            (X11 - originUtm[0]) * M2FT,
            (Y11 - originUtm[1]) * horizontalScaleY * M2FT,
            z11
          ];
          faces.push({ p1: v00, p2: v10, p3: v11, p4: v01, layer: "Terrain_3D" });
        }
      }
      console.log("[export-dxf] Terrain_3D sampleElevation range:", { minZ: terrainMinZ, maxZ: terrainMaxZ });

      // collect building meshes (placed on terrain if available)
      for (const f of features) {
        if (!f.geometry) continue;
        if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") continue;
        if (!(f.properties && (f.properties.building || f.properties["building:part"])) ) continue;
        const heightMeters = heightFromProps(f.properties || {});
        const height = heightMeters * M2FT;
        const coordsAny: any = f.geometry.coordinates;
        const polys: any[] = f.geometry.type === "Polygon" ? [coordsAny] : coordsAny;
        for (const poly of polys) {
          const outer: number[][] = poly[0];
          const holes: number[][][] = poly.slice(1) || [];
          const flat: number[] = [];
          const holeIndices: number[] = [];
          const ringLocal = (ring: number[][]) => ring.map(([lon,lat])=>{
            const [x,y]=toUtm.forward([lon,lat]);
            return [
              (x-originUtm[0]) * M2FT,
              (y-originUtm[1]) * horizontalScaleY * M2FT,
            ] as [number,number];
          });
          const outerLocal = ringLocal(outer);
          const holesLocal = holes.map(r=>ringLocal(r));
          const pushRing = (ring: [number,number][]) => { for (const [x,y] of ring) { flat.push(x,y); } };
          pushRing(outerLocal);
          let idx = outerLocal.length;
          for (const h of holesLocal) { holeIndices.push(idx); pushRing(h); idx += h.length; }
          const tris = earcut(flat, holeIndices, 2);
          const base: [number,number,number][] = [];
          const top: [number,number,number][] = [];
          let minBaseZ = Number.POSITIVE_INFINITY;
          for (let i=0;i<flat.length;i+=2) {
            const x = flat[i], y = flat[i+1];
            let z0 = 0;
            try {
              // x,y are already in feet and include horizontalScaleY along Y.
              // To get back to UTM coordinates (meters), we need to invert this transform.
              const xU = x / M2FT + originUtm[0];
              const yU = y / (horizontalScaleY * M2FT) + originUtm[1];
              const [lon,lat] = toLonLat.forward([xU, yU]);
              z0 = sampleBuilding(lon, lat) ?? 0;
            } catch {}
            if (z0 < minBaseZ) minBaseZ = z0;
            base.push([x,y,0]);
          }
          if (!Number.isFinite(minBaseZ)) minBaseZ = 0;
          const baseZ = minBaseZ;
          const roofZ = baseZ + height;
          for (let i=0;i<base.length;i++) {
            base[i][2] = baseZ;
          }
          for (let i=0;i<flat.length;i+=2) {
            const x = flat[i], y = flat[i+1];
            top.push([x,y,roofZ]);
          }
          // top and bottom triangles
          for (let i=0;i<tris.length;i+=3) {
            const a=tris[i], b=tris[i+1], c=tris[i+2];
            faces.push({ p1: top[a], p2: top[b], p3: top[c], p4: top[c], layer: "Buildings_3D" });
            faces.push({ p1: base[a], p2: base[c], p3: base[b], p4: base[b], layer: "Buildings_3D" });
          }
          // sides for outer and holes
          const addSides = (ring: [number,number][], offset: number) => {
            for (let i=0;i<ring.length;i++) {
              const a = offset + i;
              const b = offset + ((i+1)%ring.length);
              const A0 = base[a]; const B0 = base[b];
              const A1 = top[a];  const B1 = top[b];
              // quad split into two triangles
              faces.push({ p1: A0, p2: B0, p3: B1, p4: A1, layer: "Buildings_3D" });
              faces.push({ p1: A0, p2: B1, p3: A1, p4: A1, layer: "Buildings_3D" });
            }
          };
          addSides(outerLocal, 0);
          let off = outerLocal.length;
          for (const h of holesLocal) { addSides(h, off); off += h.length; }
        }
      }

      // 3D roads as narrow ribbons following DEM (sampleBuilding), on layer Roads_3D
      const roadHalfWidth = 2; // ~4 m total width (approx)
      const makeRoadFace = (
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number
      ) => {
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = (-dy / len) * roadHalfWidth;
        const ny = (dx / len) * roadHalfWidth;
        const v1: [number, number, number] = [ax + nx, ay + ny, az];
        const v2: [number, number, number] = [ax - nx, ay - ny, az];
        const v3: [number, number, number] = [bx - nx, by - ny, bz];
        const v4: [number, number, number] = [bx + nx, by + ny, bz];
        faces.push({ p1: v1, p2: v2, p3: v3, p4: v4, layer: "Roads_3D" });
      };

      for (const f of features) {
        if (!f.geometry) continue;
        if (!(f.properties && f.properties.highway)) continue;
        const geom = f.geometry;
        const processLine = (line: number[][]) => {
          if (!line || line.length < 2) return;
          let prev: { x: number; y: number; z: number } | null = null;
          for (const pt of line) {
            const lon = pt[0];
            const lat = pt[1];
            const [xU, yU] = toUtm.forward([lon, lat]);
            const x = (xU - originUtm[0]) * M2FT;
            const y = (yU - originUtm[1]) * horizontalScaleY * M2FT;
            let z = 0;
            try {
              // For DEM sampling we must use the original UTM coordinates in meters,
              // without Y scaling and without converting to feet.
              const [lonSample, latSample] = toLonLat.forward([xU, yU]);
              z = sampleBuilding(lonSample, latSample) ?? 0;
            } catch {}
            if (prev) {
              makeRoadFace(prev.x, prev.y, prev.z, x, y, z);
            }
            prev = { x, y, z };
          }
        };

        if (geom.type === "LineString") {
          processLine(geom.coordinates as number[][]);
        } else if (geom.type === "MultiLineString") {
          for (const line of geom.coordinates as number[][][]) {
            processLine(line);
          }
        }
      }

      // minimal DXF writer for 3DFACE
      const sb: string[] = [];
      const push = (k: string|number, v?: string|number) => {
        sb.push(String(k)); if (v !== undefined) sb.push(String(v));
      };
      // HEADER
      push(0,"SECTION"); push(2,"HEADER"); push(0,"ENDSEC");
      // TABLES with LTYPE and LAYER
      push(0,"SECTION"); push(2,"TABLES");
      // LTYPE table minimal CONTINUOUS
      push(0,"TABLE"); push(2,"LTYPE"); push(70,1);
      push(0,"LTYPE"); push(2,"CONTINUOUS"); push(70,0); push(3,"Solid line"); push(72,65); push(73,0); push(40,0.0);
      push(0,"ENDTAB");
      // LAYER table (3D buildings, terrain, and roads)
      push(0,"TABLE"); push(2,"LAYER"); push(70,13);
      const addLayer = (name:string, color:number) => { push(0,"LAYER"); push(2,name); push(70,0); push(62,color); push(6,"CONTINUOUS"); };
      // 8 = gray, 7 = black/white depending on background
      addLayer("Buildings_3D", 8); // buildings - gray
      addLayer("Terrain_3D", 8);   // terrain - gray
      addLayer("Roads_3D", 7);     // 3D roads - black
      // Parks green, Water blue
      addLayer("Parks", 3);
      addLayer("Water", 5);
      addLayer("StreetNames", 1);
      push(0,"ENDTAB");
      push(0,"ENDSEC");
      // ENTITIES
      push(0,"SECTION"); push(2,"ENTITIES");
      console.log(`[export-dxf] Total 3DFACE count: ${faces.length}`);
      for (const f of faces) {
        push(0,"3DFACE");
        push(8,f.layer);
        push(10,f.p1[0]); push(20,f.p1[1]); push(30,f.p1[2]);
        push(11,f.p2[0]); push(21,f.p2[1]); push(31,f.p2[2]);
        push(12,f.p3[0]); push(22,f.p3[1]); push(32,f.p3[2]);
        push(13,f.p4[0]); push(23,f.p4[1]); push(33,f.p4[2]);
      }

      push(0,"ENDSEC");
      push(0,"EOF");
      const content3d = sb.join("\n");
      return new Response(content3d, {
        headers: {
          "Content-Type": "application/dxf",
          "Content-Disposition": "attachment; filename=export.dxf",
        },
      });
    } catch (err: any) {
      // Fallback: if 3D writer fails entirely, log and report error detail
      console.error("[export-dxf] 3D writer failed:", err);
      return new Response(
        JSON.stringify({ error: "server_error", detail: String(err?.message || err) }),
        { status: 500 }
      );
    }
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err?.message || err) }), { status: 500 });
  }
}

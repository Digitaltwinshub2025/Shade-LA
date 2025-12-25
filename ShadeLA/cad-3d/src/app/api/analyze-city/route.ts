import { NextRequest } from "next/server";

export const runtime = "nodejs";

 const FT2M = 0.3048;

 function bboxFromFootprints(
   newBuilding: { footprint: [number, number][] } | null | undefined,
   contextBuildings: Array<{ footprint: [number, number][] }> | null | undefined,
   paddingDeg: number
 ): [number, number, number, number] | null {
   let w = Number.POSITIVE_INFINITY;
   let s = Number.POSITIVE_INFINITY;
   let e = Number.NEGATIVE_INFINITY;
   let n = Number.NEGATIVE_INFINITY;

   const addPts = (pts: [number, number][] | null | undefined) => {
     if (!pts || !pts.length) return;
     for (const p of pts) {
       const lon = Number(p?.[0]);
       const lat = Number(p?.[1]);
       if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
       if (lon < w) w = lon;
       if (lon > e) e = lon;
       if (lat < s) s = lat;
       if (lat > n) n = lat;
     }

   };

   addPts(newBuilding?.footprint);
   for (const b of contextBuildings || []) addPts(b?.footprint);

   if (!Number.isFinite(w) || !Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(n)) return null;
   if (w === e || s === n) return null;

   return [w - paddingDeg, s - paddingDeg, e + paddingDeg, n + paddingDeg];
 }

 type GeoJSONFeatureCollection = {
   type: "FeatureCollection";
   features: Array<{
     type: "Feature";
     properties: Record<string, any>;
     geometry:
       | { type: "LineString"; coordinates: [number, number][] }
       | { type: "MultiLineString"; coordinates: [number, number][][] };
   }>;
 };

 function quantizeLevel(v: number, step: number): number {
   if (!Number.isFinite(v) || !Number.isFinite(step) || step <= 0) return v;
   return Math.round(v / step) * step;
 }

 function buildContourGeoJson(
   bbox: [number, number, number, number],
   gridN: number,
   heightsMeters: number[],
   levelsMeters: number[]
 ): GeoJSONFeatureCollection {
   const [w, s, e, n] = bbox;
   const dx = gridN > 1 ? (e - w) / (gridN - 1) : 0;
   const dy = gridN > 1 ? (n - s) / (gridN - 1) : 0;

   const point = (i: number, j: number): [number, number] => [w + i * dx, s + j * dy];
   const zAt = (i: number, j: number): number => heightsMeters[j * gridN + i];

   type Seg = { a: [number, number]; b: [number, number] };

   const segmentsByLevel = new Map<number, Seg[]>();
   for (const lv of levelsMeters) segmentsByLevel.set(lv, []);

   const interp = (p0: [number, number], z0: number, p1: [number, number], z1: number, lv: number): [number, number] => {
     if (!Number.isFinite(z0) || !Number.isFinite(z1) || z0 === z1) return [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
     const t = (lv - z0) / (z1 - z0);
     const tt = Math.max(0, Math.min(1, t));
     return [p0[0] + (p1[0] - p0[0]) * tt, p0[1] + (p1[1] - p0[1]) * tt];
   };

   for (let j = 0; j < gridN - 1; j++) {
     for (let i = 0; i < gridN - 1; i++) {
       const p00 = point(i, j);
       const p10 = point(i + 1, j);
       const p11 = point(i + 1, j + 1);
       const p01 = point(i, j + 1);
       const z00 = zAt(i, j);
       const z10 = zAt(i + 1, j);
       const z11 = zAt(i + 1, j + 1);
       const z01 = zAt(i, j + 1);
       if (![z00, z10, z11, z01].every(Number.isFinite)) continue;

       for (const lv of levelsMeters) {
         const b0 = z00 >= lv ? 1 : 0;
         const b1 = z10 >= lv ? 1 : 0;
         const b2 = z11 >= lv ? 1 : 0;
         const b3 = z01 >= lv ? 1 : 0;
         const code = b0 | (b1 << 1) | (b2 << 2) | (b3 << 3);
         if (code === 0 || code === 15) continue;

         const e0 = interp(p00, z00, p10, z10, lv);
         const e1 = interp(p10, z10, p11, z11, lv);
         const e2 = interp(p11, z11, p01, z01, lv);
         const e3 = interp(p01, z01, p00, z00, lv);

         const segs = segmentsByLevel.get(lv)!;
         switch (code) {
           case 1:
           case 14:
             segs.push({ a: e3, b: e0 });
             break;
           case 2:
           case 13:
             segs.push({ a: e0, b: e1 });
             break;
           case 3:
           case 12:
             segs.push({ a: e3, b: e1 });
             break;
           case 4:
           case 11:
             segs.push({ a: e1, b: e2 });
             break;
           case 6:
           case 9:
             segs.push({ a: e0, b: e2 });
             break;
           case 7:
           case 8:
             segs.push({ a: e3, b: e2 });
             break;
           case 5:
             segs.push({ a: e3, b: e0 });
             segs.push({ a: e1, b: e2 });
             break;
           case 10:
             segs.push({ a: e0, b: e1 });
             segs.push({ a: e2, b: e3 });
             break;
           default:
             break;
         }
       }
     }
   }

   const snapKey = (p: [number, number]) => `${p[0].toFixed(10)},${p[1].toFixed(10)}`;
   const features: GeoJSONFeatureCollection["features"] = [];

   for (const [lv, segs] of segmentsByLevel) {
     const adj = new Map<string, Array<{ k: string; idx: number }>>();
     const segA: string[] = [];
     const segB: string[] = [];
     const keyToPoint = new Map<string, [number, number]>();

     for (let si = 0; si < segs.length; si++) {
       const aK = snapKey(segs[si].a);
       const bK = snapKey(segs[si].b);
       segA[si] = aK;
       segB[si] = bK;
       keyToPoint.set(aK, segs[si].a);
       keyToPoint.set(bK, segs[si].b);
       if (!adj.has(aK)) adj.set(aK, []);
       if (!adj.has(bK)) adj.set(bK, []);
       adj.get(aK)!.push({ k: bK, idx: si });
       adj.get(bK)!.push({ k: aK, idx: si });
     }

     const used = new Array(segs.length).fill(false);
     const polylines: [number, number][][] = [];

     for (let si = 0; si < segs.length; si++) {
       if (used[si]) continue;
       used[si] = true;
       const line: [number, number][] = [keyToPoint.get(segA[si])!, keyToPoint.get(segB[si])!];

       let head = segA[si];
       let tail = segB[si];

       const extend = (endKey: string, pushFront: boolean) => {
         while (true) {
           const next = (adj.get(endKey) || []).find((l) => !used[l.idx]);
           if (!next) break;
           used[next.idx] = true;
           const nextKey = next.k;
           if (pushFront) {
             line.unshift(keyToPoint.get(nextKey)!);
             endKey = nextKey;
           } else {
             line.push(keyToPoint.get(nextKey)!);
             endKey = nextKey;
           }
         }
         return endKey;
       };

       head = extend(head, true);
       tail = extend(tail, false);

       if (line.length >= 2) polylines.push(line);
     }

     if (polylines.length) {
       features.push({
         type: "Feature",
         properties: { elevationMeters: lv, elevationFeet: lv / FT2M },
         geometry: polylines.length === 1
           ? { type: "LineString", coordinates: polylines[0] }
           : { type: "MultiLineString", coordinates: polylines },
       });
     }
   }

   return { type: "FeatureCollection", features };
 }

 async function fetchDemForBbox(bbox: [number, number, number, number]): Promise<Buffer | null> {
   const [w, s, e, n] = bbox;
   const bboxParam = `${w},${s},${e},${n}`;
   const baseUrl = "https://tnmaccess.nationalmap.gov/api/v1/products";
   const url = `${baseUrl}?f=json&bbox=${encodeURIComponent(
     bboxParam
   )}&bboxSR=4326&datasets=${encodeURIComponent(
     "3DEP Digital Elevation Model (DEM) 1/3 arc-second"
   )}&prodFormats=${encodeURIComponent("GeoTIFF")}&max=1`;

   try {
     const r = await fetch(url);
     if (!r.ok) return null;
     const json: any = await r.json();
     const products: any[] = json?.products || json?.items || [];
     if (!products.length) return null;

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
     if (!downloadUrl) return null;

     const demResp = await fetch(downloadUrl);
     if (!demResp.ok) return null;
     return Buffer.from(await demResp.arrayBuffer());
   } catch {
     return null;
   }
 }

 async function buildTerrainGridFromDem(
   demBuf: Buffer,
   bbox: [number, number, number, number],
   gridN: number,
   normalizeToMin: boolean
 ): Promise<{
   gridN: number;
   heightsMeters: number[];
   minZ: number;
   maxZ: number;
   demMeta: {
     demBbox: [number, number, number, number];
     width: number;
     height: number;
     pixelSizeDegrees?: [number, number];
     noData?: number;
     scale?: number;
     offset?: number;
   };
 }> {
   const { fromArrayBuffer } = await import("geotiff");
   const ab = demBuf.buffer.slice(demBuf.byteOffset, demBuf.byteOffset + demBuf.byteLength) as ArrayBuffer;
   const tiff = await fromArrayBuffer(ab);
   const image = await tiff.getImage();
   const width = image.getWidth();
   const height = image.getHeight();
   const rasters = (await image.readRasters({ interleave: true })) as Float32Array | number[];
   const elevation = rasters as any;

   const demBbox = image.getBoundingBox() as [number, number, number, number];
   const minX = demBbox[0];
   const minY = demBbox[1];
   const maxX = demBbox[2];
   const maxY = demBbox[3];

   const gdalMeta: any = (image as any).getGDALMetadata ? (image as any).getGDALMetadata() : undefined;
   const fileDir: any = (image as any).fileDirectory || {};
   const noDataRaw =
     gdalMeta?.NoData != null ? Number(gdalMeta.NoData) :
     gdalMeta?.NODATA != null ? Number(gdalMeta.NODATA) :
     fileDir?.GDAL_NODATA != null ? Number(fileDir.GDAL_NODATA) :
     undefined;
   const noData = Number.isFinite(noDataRaw) ? noDataRaw : undefined;
   const scaleRaw = fileDir?.ModelPixelScale ? undefined : undefined;
   const scale = Number.isFinite(Number(fileDir?.Scale)) ? Number(fileDir.Scale) : undefined;
   const offset = Number.isFinite(Number(fileDir?.Offset)) ? Number(fileDir.Offset) : undefined;

   const pixelSizeDegrees = (() => {
     if (width <= 1 || height <= 1) return undefined;
     const dx = (maxX - minX) / (width - 1);
     const dy = (maxY - minY) / (height - 1);
     if (!Number.isFinite(dx) || !Number.isFinite(dy)) return undefined;
     return [dx, dy] as [number, number];
   })();

   const toZ = (z: number): number => {
     if (!Number.isFinite(z)) return NaN;
     if (noData !== undefined && z === noData) return NaN;
     let v = z;
     if (scale !== undefined) v = v * scale;
     if (offset !== undefined) v = v + offset;
     return v;
   };

   const baseSample = (lon: number, lat: number): number => {
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
     const z00 = toZ(Number(elevation[idx(ix, iy)]));
     const z10 = toZ(Number(elevation[idx(ix + 1, iy)]));
     const z01 = toZ(Number(elevation[idx(ix, iy + 1)]));
     const z11 = toZ(Number(elevation[idx(ix + 1, iy + 1)]));

     // If we have enough valid corners, do bilinear on valid values; otherwise fall back to nearest valid.
     const w00 = (1 - tx) * (1 - ty);
     const w10 = tx * (1 - ty);
     const w01 = (1 - tx) * ty;
     const w11 = tx * ty;

     let sumW = 0;
     let sum = 0;
     const add = (z: number, w: number) => {
       if (!Number.isFinite(z)) return;
       sumW += w;
       sum += z * w;
     };
     add(z00, w00);
     add(z10, w10);
     add(z01, w01);
     add(z11, w11);

     if (sumW > 0) return sum / sumW;

     // All invalid -> return NaN (handled later)
     return NaN;
   };

   const [w, s, e, n] = bbox;
   const heightsMeters: number[] = new Array(gridN * gridN);
   let minZ = Number.POSITIVE_INFINITY;
   let maxZ = Number.NEGATIVE_INFINITY;
   for (let j = 0; j < gridN; j++) {
     const tY = gridN === 1 ? 0.5 : j / (gridN - 1);
     const lat = s + (n - s) * tY;
     for (let i = 0; i < gridN; i++) {
       const tX = gridN === 1 ? 0.5 : i / (gridN - 1);
       const lon = w + (e - w) * tX;
       const z = baseSample(lon, lat);
       heightsMeters[j * gridN + i] = z;
       if (Number.isFinite(z)) {
         if (z < minZ) minZ = z;
         if (z > maxZ) maxZ = z;
       }
     }
   }

   if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
     minZ = 0;
     maxZ = 0;
   }

   if (normalizeToMin && Number.isFinite(minZ)) {
     for (let k = 0; k < heightsMeters.length; k++) {
       const z = heightsMeters[k];
       heightsMeters[k] = Number.isFinite(z) ? z - minZ : NaN;
     }
     maxZ = maxZ - minZ;
     minZ = 0;
   }

   return {
     gridN,
     heightsMeters,
     minZ,
     maxZ,
     demMeta: {
       demBbox,
       width,
       height,
       pixelSizeDegrees,
       noData,
       scale,
       offset,
     },
   };
 }

interface LatLon {
  lat: number;
  lon: number;
  timeZone?: number;
}

interface AnalysisBoundary {
  month: number;
  day: number;
  hour: number;
}

interface AnalysisPeriod {
  start: AnalysisBoundary;
  end: AnalysisBoundary;
}

interface ContextBuilding {
  id?: string;
  footprint: [number, number][];
  height: number;
}

interface NewBuilding {
  id?: string;
  footprint: [number, number][];
  height: number;
}

interface AnalyzeCityRequestBody {
  location: LatLon;
  analysisPeriod: AnalysisPeriod;
  contextBuildings: ContextBuilding[];
  newBuilding: NewBuilding;
  bbox?: [number, number, number, number];
  options?: {
    gridResolution?: number;
    analyzeGround?: boolean;
    analyzeFacades?: boolean;
    terrainNormalizeToMin?: boolean;
    contours?: {
      intervalMeters?: number;
      intervalFeet?: number;
      levelsMeters?: number[];
      levelsFeet?: number[];
      minMeters?: number;
      maxMeters?: number;
      maxLevels?: number;
    };
  };
}

interface AnalyzeCityProxyResponse {
  ok: boolean;
  ghUrl?: string;
  ghStatus?: number;
  ghBody?: unknown;
  terrain?: {
    bbox: [number, number, number, number];
    gridN: number;
    heightsMeters: number[];
    minZ: number;
    maxZ: number;
    demMeta: {
      demBbox: [number, number, number, number];
      width: number;
      height: number;
      pixelSizeDegrees?: [number, number];
      noData?: number;
      scale?: number;
      offset?: number;
    };
  };
  contours?: GeoJSONFeatureCollection;
  error?: string;
}

export async function POST(req: NextRequest) {
  let body: AnalyzeCityRequestBody | null = null;

  try {
    body = (await req.json()) as AnalyzeCityRequestBody;
  } catch (err: any) {
    const res: AnalyzeCityProxyResponse = {
      ok: false,
      error: "invalid_json",
    };
    return new Response(JSON.stringify(res), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body) {
    const res: AnalyzeCityProxyResponse = {
      ok: false,
      error: "missing_body",
    };
    return new Response(JSON.stringify(res), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.analysisPeriod || !body.analysisPeriod.start || !body.analysisPeriod.end) {
    const res: AnalyzeCityProxyResponse = {
      ok: false,
      error: "missing_analysisPeriod",
    };
    return new Response(JSON.stringify(res), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const wantTerrain = !!body.options?.analyzeGround;
  const bbox = body.bbox ?? bboxFromFootprints(body.newBuilding, body.contextBuildings, 0.002);
  if (wantTerrain && !bbox) {
    const res: AnalyzeCityProxyResponse = {
      ok: false,
      error: "missing_bbox_for_terrain",
    };
    return new Response(JSON.stringify(res), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let terrain: AnalyzeCityProxyResponse["terrain"] | undefined = undefined;
  let contours: AnalyzeCityProxyResponse["contours"] | undefined = undefined;
  if (wantTerrain && bbox) {
    const gridN = (() => {
      const v = Number(body.options?.gridResolution);
      if (!Number.isFinite(v)) return 64;
      const n = Math.floor(v);
      return Math.max(2, Math.min(256, n));
    })();

    const demBuf = await fetchDemForBbox(bbox);
    if (!demBuf) {
      const res: AnalyzeCityProxyResponse = {
        ok: false,
        error: "dem_not_available",
      };
      return new Response(JSON.stringify(res), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const normalizeToMin = !!body.options?.terrainNormalizeToMin;
      const grid = await buildTerrainGridFromDem(demBuf, bbox, gridN, normalizeToMin);
      terrain = { bbox, ...grid };

      const contourOpts = body.options?.contours;
      if (contourOpts) {
        const maxLevels = (() => {
          const v = Number(contourOpts.maxLevels);
          return Number.isFinite(v) ? Math.max(1, Math.min(200, Math.floor(v))) : 50;
        })();

        const clampMin = Number.isFinite(Number(contourOpts.minMeters)) ? Number(contourOpts.minMeters) : grid.minZ;
        const clampMax = Number.isFinite(Number(contourOpts.maxMeters)) ? Number(contourOpts.maxMeters) : grid.maxZ;

        let levels: number[] = [];
        if (Array.isArray(contourOpts.levelsMeters) && contourOpts.levelsMeters.length) {
          levels = contourOpts.levelsMeters
            .map((x) => Number(x))
            .filter((x) => Number.isFinite(x))
            .filter((x) => x >= clampMin && x <= clampMax)
            .slice(0, maxLevels);
        } else if (Array.isArray(contourOpts.levelsFeet) && contourOpts.levelsFeet.length) {
          levels = contourOpts.levelsFeet
            .map((x) => Number(x))
            .filter((x) => Number.isFinite(x))
            .map((ft) => ft * FT2M)
            .filter((x) => x >= clampMin && x <= clampMax)
            .slice(0, maxLevels);
        } else {
          const intervalFeet = Number(contourOpts.intervalFeet);
          const intervalMeters = Number(contourOpts.intervalMeters);
          const step = Number.isFinite(intervalFeet) && intervalFeet > 0
            ? intervalFeet * FT2M
            : Number.isFinite(intervalMeters) && intervalMeters > 0
              ? intervalMeters
              : 10;
          const start = quantizeLevel(clampMin, step);
          for (let v = start; v <= clampMax + 1e-9 && levels.length < maxLevels; v += step) {
            levels.push(v);
          }
        }

        if (levels.length) {
          contours = buildContourGeoJson(bbox, grid.gridN, grid.heightsMeters, levels);
        }
      }
    } catch (err: any) {
      const res: AnalyzeCityProxyResponse = {
        ok: false,
        error: "dem_parse_failed: " + String(err?.message || err),
      };
      return new Response(JSON.stringify(res), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const ghPayload = {
    definition: "GHSunPath.gh",
    inputs: {
      x: 2,
    },
  };

  const baseUrl = process.env.COMPUTE_APPSERVER_URL || "http://localhost:6501";
  const ghUrl = new URL("/solve", baseUrl).toString();

  try {
    const r = await fetch(ghUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ghPayload),
    });

    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    const res: AnalyzeCityProxyResponse = {
      ok: r.ok,
      ghUrl,
      ghStatus: r.status,
      ghBody: parsed,
      terrain,
      contours,
    };

    return new Response(JSON.stringify(res), {
      status: r.ok ? 200 : 502,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    const res: AnalyzeCityProxyResponse = {
      ok: false,
      ghUrl,
      terrain,
      contours,
      error: String(err?.message || err),
    };
    return new Response(JSON.stringify(res), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

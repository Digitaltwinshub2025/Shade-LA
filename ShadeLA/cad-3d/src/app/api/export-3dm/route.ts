import { NextRequest } from "next/server";
import proj4 from "proj4";

export const runtime = "nodejs";

// Meters-to-feet conversion factor (for UTM coordinates and elevations).
const M2FT = 3.280839895;

async function fetchDemForBbox(bbox: [number, number, number, number]): Promise<Buffer | null> {
  const [w, s, e, n] = bbox;
  const bboxParam = `${w},${s},${e},${n}`;
  const baseUrl = "https://tnmaccess.nationalmap.gov/api/v1/products";
  const url = `${baseUrl}?f=json&bbox=${encodeURIComponent(
    bboxParam
  )}&bboxSR=4326&prodFormats=${encodeURIComponent("GeoTIFF")}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      return null;
    }
    const json: any = await r.json();
    const products: any[] = json?.products || json?.items || [];
    if (!products.length) {
      return null;
    }

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
      return null;
    }
    const demResp = await fetch(downloadUrl);
    if (!demResp.ok) {
      return null;
    }
    const buf = Buffer.from(await demResp.arrayBuffer());
    return buf;
  } catch {
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

function heightFromProps(props: any): number {
  if (!props) return 10;
  const parseNum = (v: any) => {
    const n = parseFloat(String(v));
    return isNaN(n) ? undefined : n;
  };
  const h1 = parseNum(props.height);
  if (h1 !== undefined) return h1;
  const h2 = parseNum(props["building:height"]);
  if (h2 !== undefined) return h2;
  const lv = parseNum(props.levels) ?? parseNum(props["building:levels"]) ?? 0;
  if (lv && lv > 0) return lv * 3;
  return 10;
}

function parseBboxParam(param: string | null): [number, number, number, number] | null {
  if (!param) return null;
  const parts = param.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4) return null;
  const [w, s, e, n] = parts;
  if (![w, s, e, n].every((v) => Number.isFinite(v))) return null;
  return [w, s, e, n];
}

async function handleExport3dm(req: NextRequest, bbox: [number, number, number, number], body: any) {
  const [w, s, e, n] = bbox;

  let baseSample = (lon: number, lat: number): number => 0;
  let sampleTerrain = (lon: number, lat: number): number => 0;
  let sampleBuilding = (lon: number, lat: number): number => 0;
  let demBuf: Buffer | null = null;
  try {
    demBuf = await fetchDemForBbox(bbox);
    if (demBuf) {
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
      const demBbox = image.getBoundingBox();
      const minX = demBbox[0];
      const minY = demBbox[1];
      const maxX = demBbox[2];
      const maxY = demBbox[3];
      const terrainZEx = (() => {
        const src = (body && (body as any).terrainExaggeration) != null
          ? (body as any).terrainExaggeration
          : process.env.TERRAIN_Z_EXAGGERATION;
        const v = Number(src);
        return isNaN(v) || v <= 0 ? 1 : v;
      })();

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

      const clearanceFt = (() => {
        const src = (body && (body as any).buildingsClearanceFt) != null
          ? (body as any).buildingsClearanceFt
          : process.env.BUILDINGS_CLEARANCE_FT;
        const v = Number(src);
        return isNaN(v) ? 0.5 : Math.max(0, v);
      })();

      const demVerticalScale = (() => {
        const src = (body && (body as any).demVerticalScale) != null
          ? (body as any).demVerticalScale
          : process.env.DEM_VERTICAL_SCALE;
        const v = Number(src);
        return isNaN(v) || v === 0 ? 1 : v;
      })();

      const maxTerrainHeightMeters = (() => {
        const src = (body && (body as any).terrainMaxHeight) != null
          ? (body as any).terrainMaxHeight
          : process.env.TERRAIN_MAX_HEIGHT;
        const v = Number(src);
        return isNaN(v) || v <= 0 ? Number.POSITIVE_INFINITY : v;
      })();

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

      const terrainOffset = 0.5 * M2FT;
      sampleTerrain = (lon: number, lat: number): number => {
        const base = baseSample(lon, lat) * terrainZEx;
        return base - terrainOffset;
      };

      sampleBuilding = (lon: number, lat: number): number => {
        const base = baseSample(lon, lat) * terrainZEx;
        const terrainZ = base - terrainOffset;
        let z = base * buildingsZEx + buildingsZOffset;
        if (!Number.isFinite(z)) z = terrainZ;
        if (z < terrainZ + clearanceFt) z = terrainZ + clearanceFt;
        return z;
      };
    }
  } catch {}

  // fetch OSM
  const query = `
      [out:xml][timeout:30];
      (
        way["building"](${s},${w},${n},${e});
        relation["building"](${s},${w},${n},${e});
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
  const originUtm = toUtm.forward([lon0, lat0]);

  const horizontalScaleY = (() => {
    const src = (body && (body as any).horizontalScaleY) != null
      ? (body as any).horizontalScaleY
      : process.env.HORIZONTAL_SCALE_Y;
    const v = Number(src);
    return isNaN(v) || v === 0 ? 1 : v;
  })();

  const path = await import("path");
  let rhino: any;
  try {
    const rhino3dmModule: any = await import("rhino3dm");
    const locate = (file: string) => path.join(process.cwd(), "node_modules", "rhino3dm", file);
    rhino = await rhino3dmModule.default({ locateFile: locate });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "rhino3dm_load_failed", detail: String(e?.message || e) }), { status: 500 });
  }

  const model = new rhino.File3dm();
  model.settings.modelUnitSystem = rhino.UnitSystem.Feet;

  // layers
  const layerTable = model.layers();
  const buildingsLayer = new rhino.Layer();
  buildingsLayer.name = "Buildings";
  buildingsLayer.color = { r: 80, g: 80, b: 80, a: 255 };
  layerTable.add(buildingsLayer);
  const refLayer = new rhino.Layer();
  refLayer.name = "Reference";
  refLayer.color = { r: 200, g: 0, b: 0, a: 255 };
  layerTable.add(refLayer);
  const terrainLayer = new rhino.Layer();
  terrainLayer.name = "Terrain";
  terrainLayer.color = { r: 160, g: 160, b: 160, a: 255 };
  layerTable.add(terrainLayer);

  const features = gj.features || [];

  const terrainMesh = new rhino.Mesh();
  const terrainVerts = terrainMesh.vertices();
  const terrainFaces = terrainMesh.faces();
  const addTerrainFace = (...args: number[]) => {
    if (!terrainFaces || typeof (terrainFaces as any).addFace !== "function") return;
    const add = (terrainFaces as any).addFace.bind(terrainFaces as any);
    if (args.length === 3) add(args[0], args[1], args[2]);
    if (args.length === 4) add(args[0], args[1], args[2], args[3]);
  };
  const gridN = 100;
  const lons: number[] = [];
  const lats: number[] = [];
  for (let i = 0; i <= gridN; i++) {
    lons.push(w + ((e - w) * i) / gridN);
    lats.push(s + ((n - s) * i) / gridN);
  }
  const vertIndex: number[][] = Array.from({ length: gridN + 1 }, () => Array(gridN + 1).fill(-1));
  for (let iy = 0; iy <= gridN; iy++) {
    for (let ix = 0; ix <= gridN; ix++) {
      const lon = lons[ix];
      const lat = lats[iy];
      const [x, y] = toUtm.forward([lon, lat]);
      const zVal = sampleTerrain(lon, lat);
      const vx = (x - originUtm[0]) * M2FT;
      const vy = (y - originUtm[1]) * horizontalScaleY * M2FT;
      vertIndex[iy][ix] = terrainVerts.add(vx, vy, zVal);
    }
  }
  for (let iy = 0; iy < gridN; iy++) {
    for (let ix = 0; ix < gridN; ix++) {
      const v00 = vertIndex[iy][ix];
      const v10 = vertIndex[iy][ix + 1];
      const v01 = vertIndex[iy + 1][ix];
      const v11 = vertIndex[iy + 1][ix + 1];
      addTerrainFace(v00, v10, v11, v01);
    }
  }
  terrainMesh.normals().computeNormals();
  model.objects().addMesh(terrainMesh, null);

  for (const f of features) {
    if (!f.geometry || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) continue;
    const props = f.properties || {};
    const heightMeters = heightFromProps(props);
    const height = heightMeters * M2FT;
    const coordsAny: any = f.geometry.coordinates;
    const polys: any[] = f.geometry.type === "Polygon" ? [coordsAny] : coordsAny;

    for (const poly of polys) {
      const outer: any[] = poly[0];
      const rings: any[] = [outer, ...poly.slice(1)];
      const mesh = new rhino.Mesh();
      const meshVerts = mesh.vertices();
      const meshFaces = mesh.faces();
      const addFace = (...args: number[]) => {
        if (!meshFaces || typeof (meshFaces as any).addFace !== "function") return;
        const add = (meshFaces as any).addFace.bind(meshFaces as any);
        if (args.length === 3) return add(args[0], args[1], args[2]);
        if (args.length === 4) return add(args[0], args[1], args[2], args[3]);
      };
      const idxBase: number[] = [];
      const idxTop: number[] = [];
      let minBaseZ = Number.POSITIVE_INFINITY;
      for (let r = 0; r < rings.length; r++) {
        const ring = rings[r] as any[];
        const ringBaseIdx: number[] = [];
        for (const pt of ring) {
          const lon = pt[0]; const lat = pt[1];
          const [x, y] = toUtm.forward([lon, lat]);
          const vx = (x - originUtm[0]) * M2FT;
          const vy = (y - originUtm[1]) * horizontalScaleY * M2FT;
          const z0 = sampleBuilding(lon, lat);
          if (z0 < minBaseZ) minBaseZ = z0;
          ringBaseIdx.push(meshVerts.add(vx, vy, 0));
        }
        if (r === 0) { idxBase.push(...ringBaseIdx); }
      }
      if (!Number.isFinite(minBaseZ)) minBaseZ = 0;
      const baseZ = minBaseZ;
      const roofZ = baseZ + height;

      for (let r = 0; r < rings.length; r++) {
        const ring = rings[r] as any[];
        const ringTopIdx: number[] = [];
        for (const pt of ring) {
          const lon = pt[0]; const lat = pt[1];
          const [x, y] = toUtm.forward([lon, lat]);
          const vx = (x - originUtm[0]) * M2FT;
          const vy = (y - originUtm[1]) * horizontalScaleY * M2FT;
          ringTopIdx.push(meshVerts.add(vx, vy, roofZ));
        }
        const ringBaseIdx: number[] = idxBase.slice(0, ring.length);
        for (let i = 0; i < ring.length; i++) {
          const a0 = ringBaseIdx[i];
          const a1 = ringBaseIdx[(i + 1) % ringBaseIdx.length];
          const b1 = ringTopIdx[(i + 1) % ringTopIdx.length];
          const b0 = ringTopIdx[i];
          addFace(a0, a1, b1, b0);
        }
        if (r === 0) { idxTop.push(...ringTopIdx); }
      }
      for (let i = 1; i + 1 < idxTop.length; i++) addFace(idxTop[0], idxTop[i], idxTop[i + 1]);
      for (let i = 1; i + 1 < idxBase.length; i++) addFace(idxBase[0], idxBase[i + 1], idxBase[i]);

      mesh.normals().computeNormals();
      model.objects().addMesh(mesh, null);
    }
  }

  const setDocText = (key: string, value: string) => {
    const anyModel: any = model as any;
    if (typeof anyModel.setDocumentUserText === "function") {
      anyModel.setDocumentUserText(key, value);
      return;
    }
    if (typeof anyModel.setUserString === "function") {
      anyModel.setUserString(key, value);
      return;
    }
  };

  setDocText("units", "meters");
  setDocText("epsg", `EPSG:${utm.epsg}`);
  setDocText("origin_lon", String(lon0));
  setDocText("origin_lat", String(lat0));
  setDocText("utm_origin_easting", String(originUtm[0]));
  setDocText("utm_origin_northing", String(originUtm[1]));
  setDocText("bbox", JSON.stringify({ west: w, south: s, east: e, north: n }));
  setDocText("true_north_deg", "0");

  const bytes = new Uint8Array(model.toByteArray());
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=export_3dm.3dm",
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    const bbox = parseBboxParam(req.nextUrl.searchParams.get("bbox"));
    if (!bbox) return new Response(JSON.stringify({ error: "bbox required" }), { status: 400 });
    return await handleExport3dm(req, bbox, { bbox });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err?.message || err) }), { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const bbox = body?.bbox as [number, number, number, number] | undefined; // [w,s,e,n]
    if (!bbox) return new Response(JSON.stringify({ error: "bbox required" }), { status: 400 });
    return await handleExport3dm(req, bbox, body);
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err?.message || err) }), { status: 500 });
  }
}

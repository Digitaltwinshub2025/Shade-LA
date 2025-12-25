#!/usr/bin/env ts-node

/**
 * USGS-based high precision terrain + buildings exporter.
 *
 * Node/TypeScript CLI, intended to be run locally on PC.
 *
 * Usage (example):
 *   npx ts-node scripts/usgs-export/index.ts --bbox "W,S,E,N" --out "out/area1"
 *
 * For now this is just a skeleton wired into the existing project; the DEM
 * download and precise terrain mesh generation will be implemented next.
 */

import fs from "fs";
import path from "path";
import proj4 from "proj4";

interface CliOptions {
  bbox: [number, number, number, number]; // [w,s,e,n]
  outDir: string;
  terrainFile: string; // relative file name, e.g. terrain.obj
  apiBase: string; // e.g. http://localhost:3000
  exportDxf: boolean;
  export3dm: boolean;
}

function utmFromLonLat(lon: number, lat: number) {
  const zone = Math.floor((lon + 180) / 6) + 1;
  const isNorth = lat >= 0;
  const epsg = isNorth ? 32600 + zone : 32700 + zone;
  const def = `+proj=utm +zone=${zone} ${isNorth ? "+north" : "+south"} +datum=WGS84 +units=m +no_defs`;
  return { epsg, def, zone, isNorth };
}

function parseArgs(argv: string[]): CliOptions {
  let bboxStr = "";
  let outDir = "out";
  let terrainFile = "terrain.obj";
  let apiBase = process.env.EXPORT_API_BASE || "http://localhost:3000";
  let exportDxf = true;
  let export3dm = true;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bbox" && i + 1 < argv.length) {
      bboxStr = argv[++i];
    } else if ((a === "--out" || a === "-o") && i + 1 < argv.length) {
      outDir = argv[++i];
    } else if (a === "--terrain-file" && i + 1 < argv.length) {
      terrainFile = argv[++i];
    } else if (a === "--api-base" && i + 1 < argv.length) {
      apiBase = argv[++i];
    } else if (a === "--no-dxf") {
      exportDxf = false;
    } else if (a === "--no-3dm") {
      export3dm = false;
    }
  }
  if (!bboxStr) {
    console.error(
      "Usage: ts-node scripts/usgs-export/index.ts --bbox \"W,S,E,N\" --out out/dir [--terrain-file terrain.obj] [--api-base http://localhost:3000] [--no-dxf] [--no-3dm]"
    );
    process.exit(1);
  }
  const parts = bboxStr.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((v) => !isFinite(v))) {
    console.error("Invalid --bbox. Expected four numbers: W,S,E,N");
    process.exit(1);
  }
  const bbox: [number, number, number, number] = [parts[0], parts[1], parts[2], parts[3]];
  const outAbs = path.resolve(process.cwd(), outDir);
  if (!fs.existsSync(outAbs)) fs.mkdirSync(outAbs, { recursive: true });
  return { bbox, outDir: outAbs, terrainFile, apiBase, exportDxf, export3dm };
}

async function buildTerrainObjFromDem(
  demBuf: Buffer,
  outPath: string,
  bboxForUtm: [number, number, number, number]
) {
  console.log("[usgs-export] Building terrain OBJ mesh:", outPath);
  const { fromArrayBuffer } = await import("geotiff");
  const ab = demBuf.buffer.slice(
    demBuf.byteOffset,
    demBuf.byteOffset + demBuf.byteLength
  ) as ArrayBuffer;
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();

  // Use first band as elevation
  const rasters = (await image.readRasters({ interleave: true })) as Float32Array | number[];
  const elevation = rasters as any;

  // Use bounding box for XY coordinates
  const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
  const minX = bbox[0];
  const minY = bbox[1];
  const maxX = bbox[2];
  const maxY = bbox[3];
  const dx = (maxX - minX) / width;
  const dy = (maxY - minY) / height;

  const zEx = (() => {
    const v = Number(process.env.TERRAIN_Z_EXAGGERATION ?? 5);
    return isNaN(v) || v <= 0 ? 5 : v;
  })();

  // Prepare UTM projection and local origin (same logic as in API routes)
  const [w, s, e, n] = bboxForUtm;
  const lon0 = (w + e) / 2;
  const lat0 = (s + n) / 2;
  const utm = utmFromLonLat(lon0, lat0);
  const toUtm = proj4("WGS84", utm.def);
  const originUtm = toUtm.forward([lon0, lat0]);

  // Build OBJ in local UTM coordinates so it matches DXF/3DM exports
  const lines: string[] = [];
  lines.push("# terrain mesh from USGS DEM");
  lines.push("o Terrain");

  // vertices
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const idx = j * width + i;
      const z = (elevation[idx] ?? 0) * zEx;

      // Assume DEM is in geographic coordinates (lon/lat in degrees) for 3DEP 1/3 arc-second products.
      // Convert to the same local UTM system as DXF/3DM exports.
      const lon = minX + (i + 0.5) * dx;
      const lat = minY + (j + 0.5) * dy;
      const [ux, uy] = toUtm.forward([lon, lat]);
      const xLocal = ux - originUtm[0];
      const yLocal = uy - originUtm[1];

      lines.push(`v ${xLocal} ${yLocal} ${z}`);
    }
  }

  // faces (two triangles per grid cell)
  const vertIndex = (i: number, j: number) => j * width + i + 1; // OBJ is 1-based
  for (let j = 0; j < height - 1; j++) {
    for (let i = 0; i < width - 1; i++) {
      const v00 = vertIndex(i, j);
      const v10 = vertIndex(i + 1, j);
      const v01 = vertIndex(i, j + 1);
      const v11 = vertIndex(i + 1, j + 1);
      lines.push(`f ${v00} ${v10} ${v11}`);
      lines.push(`f ${v00} ${v11} ${v01}`);
    }
  }

  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log("[usgs-export] Terrain OBJ written:", outPath);
}

async function callExportApi(
  apiBase: string,
  apiPath: string,
  bbox: [number, number, number, number],
  outPath: string
) {
  const url = apiBase.replace(/\/$/, "") + apiPath;
  console.log("[usgs-export] Calling export API:", url, "→", outPath);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bbox }),
  });
  if (!resp.ok) {
    console.error("[usgs-export] Export API failed:", resp.status, resp.statusText);
    return;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log("[usgs-export] Saved export:", outPath);
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log("[usgs-export] bbox:", opts.bbox, "outDir:", opts.outDir);
  console.log("[usgs-export] terrainFile:", opts.terrainFile, "apiBase:", opts.apiBase);

  // Step 1: query USGS TNMAccess for a DEM GeoTIFF covering the bbox.
  const [w, s, e, n] = opts.bbox;
  const bboxParam = `${w},${s},${e},${n}`;
  const baseUrl = "https://tnmaccess.nationalmap.gov/api/v1/products";
  const url = `${baseUrl}?f=json&bbox=${encodeURIComponent(
    bboxParam
  )}&datasets=${encodeURIComponent(
    "3DEP Digital Elevation Model (DEM) 1/3 arc-second"
  )}&prodFormats=${encodeURIComponent("GeoTIFF")}&max=1`; // one product is enough

  console.log("[usgs-export] Requesting USGS DEM:", url);
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`[usgs-export] USGS TNMAccess request failed: ${r.status} ${r.statusText}`);
  }
  const json: any = await r.json();
  const products: any[] = json?.products || json?.items || [];
  if (!products.length) {
    throw new Error("[usgs-export] No DEM products returned for the given bbox.");
  }
  const prod = products[0];
  const downloadUrl: string | undefined = prod.downloadURL || prod.downloadUrl || prod.url;
  if (!downloadUrl) {
    throw new Error("[usgs-export] DEM product has no download URL.");
  }
  console.log("[usgs-export] DEM product:", prod.title || prod.name || "(no title)");
  console.log("[usgs-export] Downloading GeoTIFF:", downloadUrl);

  const demResp = await fetch(downloadUrl);
  if (!demResp.ok) {
    throw new Error(`[usgs-export] Failed to download DEM GeoTIFF: ${demResp.status} ${demResp.statusText}`);
  }
  const demBuf = Buffer.from(await demResp.arrayBuffer());
  const demPath = path.join(opts.outDir, "dem_usgs.tif");
  fs.writeFileSync(demPath, demBuf);
  console.log("[usgs-export] Saved DEM GeoTIFF to", demPath);
  // Open GeoTIFF with geotiff package and log raster info.
  const { fromArrayBuffer } = await import("geotiff");
  const tiff = await fromArrayBuffer(
    demBuf.buffer.slice(demBuf.byteOffset, demBuf.byteOffset + demBuf.byteLength)
  );
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters({ interleave: true });
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < (rasters as any).length; i++) {
    const v = (rasters as any)[i];
    if (v == null || isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  console.log(
    `[usgs-export] DEM size: ${width}x${height}, elevation range: ${min.toFixed(2)}..${max.toFixed(
      2
    )} (units depend on product, usually meters)`
  );

  // Build terrain OBJ mesh in the same local UTM system as DXF/3DM exports
  const terrainPath = path.join(opts.outDir, opts.terrainFile);
  await buildTerrainObjFromDem(demBuf, terrainPath, opts.bbox);

  // Call web export endpoints to generate DXF/3DM alongside the terrain
  if (opts.exportDxf) {
    const dxfPath = path.join(opts.outDir, "export_3d.dxf");
    await callExportApi(opts.apiBase, "/api/export-dxf", opts.bbox, dxfPath);
  }
  if (opts.export3dm) {
    const threeDmPath = path.join(opts.outDir, "export_3d.3dm");
    // Prefer the Rhino.Compute-aware route if available in your app
    try {
      await callExportApi(opts.apiBase, "/api/export-3dm-compute", opts.bbox, threeDmPath);
    } catch (err) {
      console.warn("[usgs-export] /api/export-3dm-compute failed, trying /api/export-3dm:", err);
      await callExportApi(opts.apiBase, "/api/export-3dm", opts.bbox, threeDmPath);
    }
  }

  console.log("[usgs-export] DEM download, terrain mesh, and DXF/3DM exports complete.");
}

main().catch((err) => {
  console.error("[usgs-export] Fatal error:", err);
  process.exit(1);
});

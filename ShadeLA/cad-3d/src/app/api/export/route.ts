import earcut from "earcut";
import { NextRequest } from "next/server";
import JSZip from "jszip";
import proj4 from "proj4";

export const runtime = "nodejs";

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

function triangulatePolygon(outer: number[][], holes: number[][][]): { positions: number[]; indices: number[] } {
  // Flatten for earcut: [x0,y0, x1,y1, ...] with hole indices offsets
  const positions: number[] = [];
  const holeIndices: number[] = [];
  // outer ring
  for (const p of outer) positions.push(p[0], p[1]);
  // holes
  for (const h of holes) {
    holeIndices.push(positions.length / 2);
    for (const p of h) positions.push(p[0], p[1]);
  }
  const indices: number[] = earcut(positions, holeIndices.length ? holeIndices : undefined);
  return { positions, indices };
}

function writeOBJ(meshes: { name: string; vertices: number[]; faces: number[] }[]) {
  let obj = "";
  let vOffset = 0;
  for (const m of meshes) {
    obj += `o ${m.name}\n`;
    for (let i = 0; i < m.vertices.length; i += 3) {
      obj += `v ${m.vertices[i].toFixed(4)} ${m.vertices[i + 1].toFixed(4)} ${m.vertices[i + 2].toFixed(4)}\n`;
    }
    for (let i = 0; i < m.faces.length; i += 3) {
      const a = m.faces[i] + 1 + vOffset;
      const b = m.faces[i + 1] + 1 + vOffset;
      const c = m.faces[i + 2] + 1 + vOffset;
      obj += `f ${a} ${b} ${c}\n`;
    }
    vOffset += m.vertices.length / 3;
  }
  return obj;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const bbox = body?.bbox as [number, number, number, number] | undefined; // [w,s,e,n]
    if (!bbox) return new Response(JSON.stringify({ error: "bbox required" }), { status: 400 });
    const [w, s, e, n] = bbox;

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
    const resp = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ data: query }).toString(),
    });
    if (!resp.ok) return new Response(JSON.stringify({ error: `overpass_${resp.status}` }), { status: 502 });
    const xml = await resp.text();
    const osmtogeojson = require("osmtogeojson");
    const { DOMParser } = require("@xmldom/xmldom");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const gj = osmtogeojson(doc, { polygonFeatures: { building: true } });

    // Prepare projection
    const lon0 = (w + e) / 2;
    const lat0 = (s + n) / 2;
    const utm = utmFromLonLat(lon0, lat0);
    const toUtm = proj4("WGS84", utm.def);
    const originUtm = toUtm.forward([lon0, lat0]);

    // Build meshes
    const meshes: { name: string; vertices: number[]; faces: number[] }[] = [];
    const features = gj.features || [];
    let idCounter = 0;

    for (const f of features) {
      if (f.geometry?.type !== "Polygon" && f.geometry?.type !== "MultiPolygon") continue;
      const props = f.properties || {};
      const height = heightFromProps(props);
      const polysAny: any[] = [];
      const coordsAny: any = (f as any).geometry.coordinates;
      if (f.geometry.type === "Polygon") {
        polysAny.push(coordsAny);
      } else {
        for (const poly of coordsAny as any[]) polysAny.push(poly);
      }
      for (const polyAny of polysAny) {
        const poly = polyAny as any[]; // [outer, ...holes]
        if (!poly.length) continue;
        const outer = (poly[0] as any[]).map((pt: any) => {
          const lon = pt[0];
          const lat = pt[1];
          const [x, y] = toUtm.forward([lon, lat]);
          return [x - originUtm[0], y - originUtm[1]];
        });
        const holes = (poly.slice(1) as any[]).map((ring: any[]) => {
          return (ring as any[]).map((pt: any) => {
            const lon = pt[0];
            const lat = pt[1];
            const [x, y] = toUtm.forward([lon, lat]);
            return [x - originUtm[0], y - originUtm[1]];
          });
        });
        const tri = triangulatePolygon(outer, holes as any);
        const vertsTop: number[] = [];
        for (let i = 0; i < tri.positions.length; i += 2) {
          vertsTop.push(tri.positions[i], tri.positions[i + 1], height);
        }
        const vertsBottom: number[] = [];
        for (let i = 0; i < tri.positions.length; i += 2) {
          vertsBottom.push(tri.positions[i], tri.positions[i + 1], 0);
        }
        // faces: top (use indices as is), bottom (reverse winding)
        const facesTop = tri.indices.slice();
        const facesBottom: number[] = [];
        for (let i = 0; i < tri.indices.length; i += 3) {
          facesBottom.push(tri.indices[i], tri.indices[i + 2], tri.indices[i + 1]);
        }
        // sides from outer ring
        const sideVerts: number[] = [];
        const sideFaces: number[] = [];
        const ring = outer;
        // We'll append sideVerts after existing vertices; compute indices later when merging
        // Accumulate meshes and merge at the end per-building; Merge vertices
        const vertices: number[] = [...vertsTop, ...vertsBottom];
        const faces: number[] = [...facesTop, ...facesBottom.map((i) => i + vertsTop.length / 3)];
        const baseIndex = vertices.length / 3;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const idx = sideVerts.length / 3;
          sideVerts.push(a[0], a[1], 0, a[0], a[1], height, b[0], b[1], height, b[0], b[1], 0);
          // two triangles per quad (v0,v1,v2) and (v0,v2,v3)
          sideFaces.push(idx, idx + 1, idx + 2, idx, idx + 2, idx + 3);
        }
        // remap sideFaces indices to global
        const sideOffset = baseIndex;
        const remappedSideFaces = sideFaces.map((i) => i + sideOffset);
        vertices.push(...sideVerts);
        faces.push(...remappedSideFaces);

        meshes.push({ name: `building_${idCounter++}`, vertices, faces });
      }
    }

    const obj = writeOBJ(meshes);

    const zip = new JSZip();
    zip.file("models/buildings.obj", obj);
    const metadata = {
      epsg: `EPSG:${utm.epsg}`,
      origin_lon: lon0,
      origin_lat: lat0,
      utm_origin_easting: originUtm[0],
      utm_origin_northing: originUtm[1],
      bbox: { west: w, south: s, east: e, north: n },
      true_north_deg: 0,
      units: "meters",
      format: "OBJ",
    };
    zip.file("metadata.json", JSON.stringify(metadata, null, 2));

    const content = await zip.generateAsync({ type: "uint8array" });
    return new Response(Buffer.from(content), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=export_obj.zip",
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err?.message || err) }), { status: 500 });
  }
}

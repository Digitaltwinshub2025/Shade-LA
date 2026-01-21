import { NextRequest } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

const CSV_PATH = path.join(process.cwd(), "CensusTract V3 (1).csv");
const TRACT_GEOJSON_PATH = path.join(process.cwd(), "cb_2020_06_tract_500k.json");

interface TractRecord {
  GEOID: string;
  NAME: string;
  County?: string;
  NAMELSAD?: string;
  Mean_Annual_Est_PM2_5: string;
  CASTHMA_CrudePrev: string;
  High_Summer_Mean_LST_F: string;
  PCT_TreeCanopy: string;
  PCT_LackingCanopy: string;
  PCT_ImperviousSurfaces: string;
  Area_SqKm: string;
  Vul_Pop_Index: string;
  Trees_Index: string;
  Heat_Buddy_Index: string;
  Cooling_Center_Index: string;
  Pres_Open_Space_Index: string;
  Reduce_Imp_Surf_Index: string;
  Restore_Builtup_Index: string;
  intervention_score: string;
  WF_HousingDensity_MEAN: string;
  WF_Exp_Type_MEAN: string;
  WF_RiskToHome_Mean: string;
  WF_HazardPotential_Mean: string;
}

let cachedHeader: string[] | null = null;
let cachedLines: string[] | null = null;
let cachedGeoGEOIDs: Set<string> | null = null;

async function loadCsv(): Promise<{ header: string[]; lines: string[] }> {
  if (cachedHeader && cachedLines) {
    return { header: cachedHeader, lines: cachedLines };
  }

  const raw = await fs.readFile(CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines.shift()?.split(",") ?? [];
  cachedHeader = header;
  cachedLines = lines;
  return { header, lines };
}

async function loadGeoGEOIDs(): Promise<Set<string>> {
  if (cachedGeoGEOIDs) return cachedGeoGEOIDs;
  try {
    const raw = await fs.readFile(TRACT_GEOJSON_PATH, "utf8");
    const gj = JSON.parse(raw);
    const features: any[] = Array.isArray(gj) ? gj : Array.isArray(gj?.features) ? gj.features : [];
    const set = new Set<string>();
    for (const f of features) {
      const props = (f && (f.properties || f)) || {};
      const geoid = String(props.GEOID || props.geoid || "").trim();
      if (geoid) set.add(geoid);
    }
    cachedGeoGEOIDs = set;
    return set;
  } catch {
    cachedGeoGEOIDs = new Set();
    return cachedGeoGEOIDs;
  }
}

function buildRecord(header: string[], row: string): TractRecord | null {
  const cols = row.split(",");
  if (cols.length < header.length) return null;

  const idx = (name: string) => header.indexOf(name);

  const get = (name: string) => {
    const i = idx(name);
    return i >= 0 ? (cols[i] ?? "") : "";
  };

  const rawGEOID = get("GEOID");
  const GEOID = rawGEOID ? rawGEOID.toString().padStart(11, "0") : "";
  const NAME = get("NAME");
  const County = get("County");
  const NAMELSAD = get("NAMELSAD");
  if (!GEOID) return null;

  return {
    GEOID,
    NAME,
    County,
    NAMELSAD,
    Mean_Annual_Est_PM2_5: get("Mean_Annual_Est_PM2_5_?g_m3"),
    CASTHMA_CrudePrev: get("CASTHMA_CrudePrev"),
    High_Summer_Mean_LST_F: get("High_Summer_Mean_LST_F"),
    PCT_TreeCanopy: get("PCT_TreeCanopy"),
    PCT_LackingCanopy: get("PCT_LackingCanopy"),
    PCT_ImperviousSurfaces: get("PCT_ImperviousSurfaces"),
    Area_SqKm: get("Area_SqKm"),
    Vul_Pop_Index: get("Vul_Pop_Index"),
    Trees_Index: get("Trees_Index"),
    Heat_Buddy_Index: get("Heat_Buddy_Index"),
    Cooling_Center_Index: get("Cooling_Center_Index"),
    Pres_Open_Space_Index: get("Pres_Open_Space_Index"),
    Reduce_Imp_Surf_Index: get("Reduce_Imp_Surf_Index"),
    Restore_Builtup_Index: get("Restore_Builtup_Index"),
    intervention_score: get("intervention_score"),
    WF_HousingDensity_MEAN: get("WF_HousingDensity_MEAN"),
    WF_Exp_Type_MEAN: get("WF_Exp_Type_MEAN"),
    WF_RiskToHome_Mean: get("WF_RiskToHome_Mean"),
    WF_HazardPotential_Mean: get("WF_HazardPotential_Mean"),
  };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const geoid = searchParams.get("geoid");

    const { header, lines } = await loadCsv();

    if (!geoid) {
      // List for the select: Los Angeles only + only GEOIDs that have geometry in GeoJSON
      const geoids = await loadGeoGEOIDs();
      const items = lines
        .map((row) => buildRecord(header, row))
        .filter((r): r is TractRecord => !!r && r.County === "Los Angeles County" && geoids.has(r.GEOID))
        .map((r) => ({ GEOID: r.GEOID, NAME: r.NAME, NAMELSAD: r.NAMELSAD }));

      return new Response(JSON.stringify(items), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const foundLine = lines.find((row) => {
      const rec = buildRecord(header, row);
      return rec && rec.GEOID === geoid && rec.County === "Los Angeles County";
    });

    if (!foundLine) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }

    const rec = buildRecord(header, foundLine);
    return new Response(JSON.stringify(rec), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err?.message || err) }), {
      status: 500,
    });
  }
}

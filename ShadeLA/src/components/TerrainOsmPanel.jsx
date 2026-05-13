import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { formatBounds } from "../terrain-osm/geo.js";
import { createMapPicker } from "../terrain-osm/map.js";
import { sampleAnalysisColor } from "../terrain-osm/analysis-colors.js";

const DEFAULT_BOUNDS = {
  minLon: -118.326047,
  minLat: 34.077448,
  maxLon: -118.320577,
  maxLat: 34.082834,
};

function clampNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function formatFixed(v, digits = 6) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(digits);
}

function boundsFromAnalyze(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const west = Number(bbox[0]);
  const south = Number(bbox[1]);
  const east = Number(bbox[2]);
  const north = Number(bbox[3]);
  if (![west, south, east, north].every((x) => Number.isFinite(x))) return null;
  return { minLon: west, minLat: south, maxLon: east, maxLat: north };
}

function buildLegendStops(steps = 9) {
  const stops = [];
  for (let index = steps - 1; index >= 0; index -= 1) {
    stops.push(index / (steps - 1));
  }
  return stops;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function createDefaultAnalysisSettings() {
  const now = new Date();
  const year = now.getFullYear();
  return {
    mode: "epw",
    analysisPeriod: {
      start_date: `${year}-06-01`,
      end_date: `${year}-06-30`,
      start_hour: 9,
      end_hour: 17,
    },
    timestep: 60,
    gridSpacing: 10,
    north: 0,
  };
}

export default function TerrainOsmPanel({ viewerRef }) {
  const mapRef = useRef(null);
  const mapPickerRef = useRef(null);
  const regenTimerRef = useRef(null);
  const regenDidInitRef = useRef(false);

  const [status, setStatus] = useState("Idle");
  const [bounds, setBounds] = useState(DEFAULT_BOUNDS);

  const [activeTab, setActiveTab] = useState("bounds");

  const [showTerrain, setShowTerrain] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [colorMode, setColorMode] = useState("ramp");
  const [hillshadeEnabled, setHillshadeEnabled] = useState(true);
  const [exaggeration, setExaggeration] = useState(1.0);

  const [showBuildings, setShowBuildings] = useState(true);
  const [defaultFloorHeight, setDefaultFloorHeight] = useState(3.2);
  const [defaultBuildingHeight, setDefaultBuildingHeight] = useState(12);
  const [buildingOpacity, setBuildingOpacity] = useState(1.0);

  const [showRoads, setShowRoads] = useState(true);
  const [roadWidthScale, setRoadWidthScale] = useState(1.0);
  const [roadOpacity, setRoadOpacity] = useState(0.7);

  const [analysisSettings, setAnalysisSettings] = useState(() => createDefaultAnalysisSettings());
  const [analysisResult, setAnalysisResult] = useState(null);

  const [analysisStatus, setAnalysisStatus] = useState("");
  const [chartsExpanded, setChartsExpanded] = useState(false);
  const [chartModalOpen, setChartModalOpen] = useState(false);
  const [chartMenu, setChartMenu] = useState(null);

  const normalizeNumericInput = (raw, { min, max, fallback }) => {
    if (raw === "" || raw === null || raw === undefined) return "";
    return clampNumber(raw, min, max);
  };

  const normalizeOnBlur = (raw, { min, max, fallback }) => {
    if (raw === "" || raw === null || raw === undefined) return fallback;
    return clampNumber(raw, min, max);
  };

  const options = useMemo(
    () => ({
      showTerrain,
      exaggeration,
      wireframe,
      colorMode,
      hillshadeEnabled,
      showBuildings,
      defaultFloorHeight,
      defaultBuildingHeight,
      buildingOpacity,
      showRoads,
      roadWidthScale,
      roadOpacity,
    }),
    [
      showTerrain,
      exaggeration,
      wireframe,
      colorMode,
      hillshadeEnabled,
      showBuildings,
      defaultFloorHeight,
      defaultBuildingHeight,
      buildingOpacity,
      showRoads,
      roadWidthScale,
      roadOpacity,
    ]
  );

  const downloadTextFile = (filename, text, mimeType) => {
    const blob = new Blob([text], { type: mimeType || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const buildSunHoursCsv = (result) => {
    if (!result?.points?.length) return "x,y,z,sun_hours\n";
    const rows = ["x,y,z,sun_hours"];
    for (let i = 0; i < result.points.length; i += 1) {
      const p = result.points[i];
      const v = result.sun_hours?.[i] ?? 0;
      rows.push(`${p[0]},${p[1]},${p[2]},${v}`);
    }
    return rows.join("\n") + "\n";
  };

  const buildSunHoursHistogramSvg = (result, { width = 860, height = 240, bins = 24 } = {}) => {
    const values = Array.isArray(result?.sun_hours) ? result.sun_hours.filter((v) => Number.isFinite(v)) : [];
    const min = Number.isFinite(result?.min) ? result.min : 0;
    const max = Number.isFinite(result?.max) ? result.max : Math.max(...values, 1);
    const range = Math.max(1e-6, max - min);

    const counts = new Array(bins).fill(0);
    values.forEach((v) => {
      const t = (v - min) / range;
      const idx = Math.min(bins - 1, Math.max(0, Math.floor(t * bins)));
      counts[idx] += 1;
    });

    const maxCount = Math.max(1, ...counts);
    const margin = { top: 34, right: 16, bottom: 40, left: 54 };
    const plotX = margin.left;
    const plotY = margin.top;
    const plotW = Math.max(1, width - margin.left - margin.right);
    const plotH = Math.max(1, height - margin.top - margin.bottom);
    const barW = plotW / bins;
    const bars = counts
      .map((count, idx) => {
        const h = (count / maxCount) * plotH;
        const x = plotX + idx * barW;
        const y = plotY + (plotH - h);
        return `<rect x=\"${x.toFixed(2)}\" y=\"${y.toFixed(2)}\" width=\"${Math.max(0, barW - 1).toFixed(
          2
        )}\" height=\"${h.toFixed(2)}\" rx=\"2\" fill=\"#93c5fd\" fill-opacity=\"0.9\" />`;
      })
      .join("");

    const axisColor = "#334155";
    const labelColor = "#cbd5e1";
    const tickColor = "#475569";
    const fontFamily = "ui-sans-serif, system-ui";

    const formatNumber = (v) => {
      if (!Number.isFinite(v)) return "0";
      if (Math.abs(v) >= 100) return String(Math.round(v));
      if (Math.abs(v) >= 10) return v.toFixed(1);
      return v.toFixed(2);
    };

    const xTicks = [min, (min + max) / 2, max];
    const yTicks = [0, maxCount];

    const xAxis = `<line x1=\"${plotX}\" y1=\"${(plotY + plotH).toFixed(2)}\" x2=\"${(plotX + plotW).toFixed(
      2
    )}\" y2=\"${(plotY + plotH).toFixed(2)}\" stroke=\"${axisColor}\" stroke-width=\"1\" />`;
    const yAxis = `<line x1=\"${plotX}\" y1=\"${plotY}\" x2=\"${plotX}\" y2=\"${(plotY + plotH).toFixed(
      2
    )}\" stroke=\"${axisColor}\" stroke-width=\"1\" />`;

    const xTickMarks = xTicks
      .map((t) => {
        const tt = (t - min) / range;
        const x = plotX + Math.max(0, Math.min(1, tt)) * plotW;
        const y = plotY + plotH;
        return `
  <line x1=\"${x.toFixed(2)}\" y1=\"${y.toFixed(2)}\" x2=\"${x.toFixed(2)}\" y2=\"${(y + 6).toFixed(
          2
        )}\" stroke=\"${tickColor}\" stroke-width=\"1\" />
  <text x=\"${x.toFixed(2)}\" y=\"${(y + 20).toFixed(
          2
        )}\" fill=\"${labelColor}\" font-family=\"${fontFamily}\" font-size=\"12\" text-anchor=\"middle\">${formatNumber(
          t
        )}</text>`;
      })
      .join("");

    const yTickMarks = yTicks
      .map((t) => {
        const tt = t / maxCount;
        const y = plotY + plotH - Math.max(0, Math.min(1, tt)) * plotH;
        const x = plotX;
        return `
  <line x1=\"${x.toFixed(2)}\" y1=\"${y.toFixed(2)}\" x2=\"${(x - 6).toFixed(
          2
        )}\" y2=\"${y.toFixed(2)}\" stroke=\"${tickColor}\" stroke-width=\"1\" />
  <text x=\"${(x - 10).toFixed(2)}\" y=\"${(y + 4).toFixed(
          2
        )}\" fill=\"${labelColor}\" font-family=\"${fontFamily}\" font-size=\"12\" text-anchor=\"end\">${Math.round(
          t
        )}</text>`;
      })
      .join("");

    const title = "Sun Hours Distribution";
    return `<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"${width}\" height=\"${height}\" viewBox=\"0 0 ${width} ${height}\">
  <rect x=\"0\" y=\"0\" width=\"${width}\" height=\"${height}\" rx=\"12\" fill=\"#0b1220\" />
  <text x=\"${margin.left}\" y=\"22\" fill=\"#e5e7eb\" font-family=\"${fontFamily}\" font-size=\"14\" font-weight=\"600\">${title}</text>

  <g>
    ${xAxis}
    ${yAxis}
    ${xTickMarks}
    ${yTickMarks}
    ${bars}
    <text x=\"${(plotX + plotW / 2).toFixed(2)}\" y=\"${(height - 10).toFixed(
      2
    )}\" fill=\"${labelColor}\" font-family=\"${fontFamily}\" font-size=\"12\" text-anchor=\"middle\">Sun hours</text>
    <text x=\"16\" y=\"${(plotY + plotH / 2).toFixed(
      2
    )}\" fill=\"${labelColor}\" font-family=\"${fontFamily}\" font-size=\"12\" text-anchor=\"middle\" transform=\"rotate(-90 16 ${(plotY + plotH / 2).toFixed(
      2
    )})\">Points</text>
  </g>
</svg>`;
  };

  useEffect(() => {
    if (!chartMenu) return;
    const close = () => setChartMenu(null);
    const onKeyDown = (e) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [chartMenu]);

  useEffect(() => {
    if (viewerRef?.current?.setOptions) {
      viewerRef.current.setOptions(options);
    }
  }, [viewerRef, options]);

  useEffect(() => {
    const mapEl = mapRef.current;
    if (!mapEl) return;

    const picker = createMapPicker(mapEl, bounds, () => {});
    mapPickerRef.current = picker;

    picker.onBoundsChanged((b) => {
      setBounds({ minLon: b.minLon, minLat: b.minLat, maxLon: b.maxLon, maxLat: b.maxLat });
    });

    return () => {
      try {
        picker.map?.remove?.();
      } catch {
        // ignore
      }
      mapPickerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      mapPickerRef.current?.setBounds?.(bounds);
    } catch {
      // ignore
    }

    try {
      viewerRef?.current?.setBounds?.(bounds);
    } catch {
      // ignore
    }
  }, [bounds, viewerRef]);

  useEffect(() => {
    const viewer = viewerRef?.current;
    if (!viewer?.generateTerrainAndOsm) return;

    if (!regenDidInitRef.current) {
      regenDidInitRef.current = true;
      return;
    }

    if (regenTimerRef.current) {
      window.clearTimeout(regenTimerRef.current);
      regenTimerRef.current = null;
    }

    setStatus("Loading city model...");
    regenTimerRef.current = window.setTimeout(() => {
      try {
        viewerRef?.current?.generateTerrainAndOsm?.();
      } catch {
        // ignore
      }
    }, 350);

    return () => {
      if (regenTimerRef.current) {
        window.clearTimeout(regenTimerRef.current);
        regenTimerRef.current = null;
      }
    };
  }, [bounds, viewerRef]);

  useEffect(() => {
    const handler = (event) => {
      const data = event?.data;
      if (!data) return;
      if (data.type !== "cadmapper:analyze") return;
      const next = boundsFromAnalyze(data.bbox);
      if (!next) return;
      setBounds(next);
      try {
        mapPickerRef.current?.setBounds?.(next, { fit: true });
      } catch {
        // ignore
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return (
    <div className="terrain-panel">
      <div className="terrain-controls">
        <div className="terrain-tabs">
          <button
            type="button"
            className={activeTab === "bounds" ? "terrain-tab terrain-tab-active" : "terrain-tab"}
            onClick={() => setActiveTab("bounds")}
          >
            Bounds
          </button>
          <button
            type="button"
            className={activeTab === "terrain" ? "terrain-tab terrain-tab-active" : "terrain-tab"}
            onClick={() => setActiveTab("terrain")}
          >
            Terrain
          </button>
          <button
            type="button"
            className={activeTab === "buildings" ? "terrain-tab terrain-tab-active" : "terrain-tab"}
            onClick={() => setActiveTab("buildings")}
          >
            Buildings
          </button>
          <button
            type="button"
            className={activeTab === "roads" ? "terrain-tab terrain-tab-active" : "terrain-tab"}
            onClick={() => setActiveTab("roads")}
          >
            Roads
          </button>
          <button
            type="button"
            className={activeTab === "solar" ? "terrain-tab terrain-tab-active" : "terrain-tab"}
            onClick={() => setActiveTab("solar")}
          >
            Solar
          </button>
        </div>

        {activeTab === "bounds" ? (
          <>
            <div className="terrain-grid">
              <label className="terrain-field">
                <input
                  value={formatFixed(bounds.minLon, 6)}
                  onChange={(e) => setBounds((b) => ({ ...b, minLon: Number(e.target.value) }))}
                />
                <span className="terrain-field-label">MinLon</span>
              </label>
              <label className="terrain-field">
                <input
                  value={formatFixed(bounds.minLat, 6)}
                  onChange={(e) => setBounds((b) => ({ ...b, minLat: Number(e.target.value) }))}
                />
                <span className="terrain-field-label">MinLat</span>
              </label>
              <label className="terrain-field">
                <input
                  value={formatFixed(bounds.maxLon, 6)}
                  onChange={(e) => setBounds((b) => ({ ...b, maxLon: Number(e.target.value) }))}
                />
                <span className="terrain-field-label">MaxLon</span>
              </label>
              <label className="terrain-field">
                <input
                  value={formatFixed(bounds.maxLat, 6)}
                  onChange={(e) => setBounds((b) => ({ ...b, maxLat: Number(e.target.value) }))}
                />
                <span className="terrain-field-label">MaxLat</span>
              </label>
            </div>

            <div className="terrain-map" ref={mapRef} style={{ height: 260 }} />
          </>
        ) : null}

        {activeTab === "terrain" ? (
          <>
            <div className="terrain-grid terrain-grid-3">
              <label className="terrain-field">
                <input
                  type="number"
                  step="0.1"
                  value={exaggeration}
                  onChange={(e) => setExaggeration(clampNumber(e.target.value, 0, 20))}
                />
                <span className="terrain-field-label">Exaggeration</span>
              </label>
              <label className="terrain-field">
                <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(!!e.target.checked)} />
                <span className="terrain-field-label">Wireframe</span>
              </label>
              <label className="terrain-field">
                <input
                  type="checkbox"
                  checked={hillshadeEnabled}
                  onChange={(e) => setHillshadeEnabled(!!e.target.checked)}
                />
                <span className="terrain-field-label">Hillshade</span>
              </label>
            </div>

            <div className="terrain-grid terrain-grid-3">
              <label className="terrain-field">
                <input type="checkbox" checked={showTerrain} onChange={(e) => setShowTerrain(!!e.target.checked)} />
                <span className="terrain-field-label">Terrain</span>
              </label>
              <label className="terrain-field">
                <select value={colorMode} onChange={(e) => setColorMode(e.target.value)}>
                  <option value="ramp">ramp</option>
                  <option value="grayscale">grayscale</option>
                </select>
                <span className="terrain-field-label">Color mode</span>
              </label>
            </div>
          </>
        ) : null}

        {activeTab === "buildings" ? (
          <>
            <div className="terrain-grid terrain-grid-2">
              <label className="terrain-field">
                <input type="checkbox" checked={showBuildings} onChange={(e) => setShowBuildings(!!e.target.checked)} />
                <span className="terrain-field-label">Buildings</span>
              </label>
              <label className="terrain-field">
                <input
                  type="number"
                  step="0.05"
                  value={buildingOpacity}
                  onChange={(e) => setBuildingOpacity(clampNumber(e.target.value, 0, 1))}
                />
                <span className="terrain-field-label">Building opacity</span>
              </label>
              <label className="terrain-field">
                <input
                  type="number"
                  step="0.1"
                  value={defaultFloorHeight}
                  onChange={(e) => setDefaultFloorHeight(clampNumber(e.target.value, 1, 10))}
                />
                <span className="terrain-field-label">Default floor height</span>
              </label>
              <label className="terrain-field">
                <input
                  type="number"
                  step="0.5"
                  value={defaultBuildingHeight}
                  onChange={(e) => setDefaultBuildingHeight(clampNumber(e.target.value, 1, 200))}
                />
                <span className="terrain-field-label">Default building height</span>
              </label>
            </div>
          </>
        ) : null}

        {activeTab === "roads" ? (
          <>
            <div className="terrain-grid terrain-grid-2">
              <label className="terrain-field">
                <input type="checkbox" checked={showRoads} onChange={(e) => setShowRoads(!!e.target.checked)} />
                <span className="terrain-field-label">Roads</span>
              </label>
              <label className="terrain-field">
                <input
                  type="number"
                  step="0.05"
                  value={roadOpacity}
                  onChange={(e) => setRoadOpacity(clampNumber(e.target.value, 0, 1))}
                />
                <span className="terrain-field-label">Road opacity</span>
              </label>
              <label className="terrain-field">
                <input
                  type="number"
                  step="0.1"
                  value={roadWidthScale}
                  onChange={(e) => setRoadWidthScale(clampNumber(e.target.value, 0.1, 8))}
                />
                <span className="terrain-field-label">Road width scale</span>
              </label>
            </div>
          </>
        ) : null}

        {activeTab === "solar" ? (
          <>
            <div className="terrain-controls-section">
              <div className="terrain-section-title">Solar analysis</div>

              <div className="terrain-meta" style={{ marginTop: 8 }}>{status}</div>

              <div className="terrain-row" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={async () => {
                    setAnalysisStatus("");
                    setStatus("Running solar analysis...");
                    try {
                      const shadeMeshes = viewerRef?.current?.getShadeMeshesForAnalysis?.() || [];
                      const result = await viewerRef?.current?.runSolarAnalysis?.(analysisSettings, { shadeMeshes });
                      setAnalysisResult(result || null);
                      setStatus("Solar analysis ready");
                    } catch (e) {
                      const msg = String(e?.message || e);
                      setStatus(`Solar analysis failed: ${msg}`);
                      setAnalysisStatus(msg);
                    }
                  }}
                >
                  Run
                </button>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      viewerRef?.current?.clearSolar?.();
                    } catch {
                      // ignore
                    }
                    setAnalysisResult(null);
                    setAnalysisStatus("");
                    setStatus("Solar cleared");
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnalysisStatus("");
                    try {
                      viewerRef?.current?.showSunPath?.(analysisSettings);
                      setStatus("Sun path shown");
                    } catch (e) {
                      setStatus("Sun path failed");
                      setAnalysisStatus(String(e?.message || e));
                    }
                  }}
                >
                  Show Sun Path
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnalysisStatus("");
                    try {
                      viewerRef?.current?.clearSunPath?.();
                      setStatus("Sun path hidden");
                    } catch (e) {
                      setStatus("Sun path failed");
                      setAnalysisStatus(String(e?.message || e));
                    }
                  }}
                >
                  Hide Sun Path
                </button>
              </div>

              <div className="terrain-grid terrain-grid-2">
                <label className="terrain-field">
                  <select
                    value={analysisSettings.mode}
                    onChange={(e) =>
                      setAnalysisSettings((s) => ({
                        ...s,
                        mode: e.target.value,
                      }))
                    }
                  >
                    <option value="epw">epw</option>
                    <option value="geometric">geometric</option>
                  </select>
                  <span className="terrain-field-label">Mode</span>
                </label>
                <label className="terrain-field">
                  <input
                    type="number"
                    step="5"
                    value={analysisSettings.timestep}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAnalysisSettings((s) => ({
                        ...s,
                        timestep: normalizeNumericInput(v, { min: 5, max: 180, fallback: 60 }),
                      }));
                    }}
                    onBlur={() => {
                      setAnalysisSettings((s) => ({
                        ...s,
                        timestep: normalizeOnBlur(s.timestep, { min: 5, max: 180, fallback: 60 }),
                      }));
                    }}
                  />
                  <span className="terrain-field-label">Timestep (min)</span>
                </label>
                <label className="terrain-field">
                  <input
                    type="date"
                    value={analysisSettings.analysisPeriod.start_date}
                    onChange={(e) =>
                      setAnalysisSettings((s) => ({
                        ...s,
                        analysisPeriod: { ...s.analysisPeriod, start_date: e.target.value },
                      }))
                    }
                  />
                  <span className="terrain-field-label">Start date</span>
                </label>
                <label className="terrain-field">
                  <input
                    type="date"
                    value={analysisSettings.analysisPeriod.end_date}
                    onChange={(e) =>
                      setAnalysisSettings((s) => ({
                        ...s,
                        analysisPeriod: { ...s.analysisPeriod, end_date: e.target.value },
                      }))
                    }
                  />
                  <span className="terrain-field-label">End date</span>
                </label>
                <label className="terrain-field">
                  <input
                    type="number"
                    step="1"
                    value={analysisSettings.analysisPeriod.start_hour}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAnalysisSettings((s) => ({
                        ...s,
                        analysisPeriod: {
                          ...s.analysisPeriod,
                          start_hour: normalizeNumericInput(v, { min: 0, max: 23, fallback: 9 }),
                        },
                      }));
                    }}
                    onBlur={() => {
                      setAnalysisSettings((s) => ({
                        ...s,
                        analysisPeriod: {
                          ...s.analysisPeriod,
                          start_hour: normalizeOnBlur(s.analysisPeriod.start_hour, { min: 0, max: 23, fallback: 9 }),
                        },
                      }));
                    }}
                  />
                  <span className="terrain-field-label">Start hour</span>
                </label>
                <label className="terrain-field">
                  <input
                    type="number"
                    step="1"
                    value={analysisSettings.analysisPeriod.end_hour}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAnalysisSettings((s) => ({
                        ...s,
                        analysisPeriod: {
                          ...s.analysisPeriod,
                          end_hour: normalizeNumericInput(v, { min: 0, max: 23, fallback: 17 }),
                        },
                      }));
                    }}
                    onBlur={() => {
                      setAnalysisSettings((s) => ({
                        ...s,
                        analysisPeriod: {
                          ...s.analysisPeriod,
                          end_hour: normalizeOnBlur(s.analysisPeriod.end_hour, { min: 0, max: 23, fallback: 17 }),
                        },
                      }));
                    }}
                  />
                  <span className="terrain-field-label">End hour</span>
                </label>
                <label className="terrain-field">
                  <input
                    type="number"
                    step="1"
                    value={analysisSettings.gridSpacing}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAnalysisSettings((s) => ({
                        ...s,
                        gridSpacing: normalizeNumericInput(v, { min: 1, max: 200, fallback: 10 }),
                      }));
                    }}
                    onBlur={() => {
                      setAnalysisSettings((s) => ({
                        ...s,
                        gridSpacing: normalizeOnBlur(s.gridSpacing, { min: 1, max: 200, fallback: 10 }),
                      }));
                    }}
                  />
                  <span className="terrain-field-label">Grid spacing (m)</span>
                </label>
                <label className="terrain-field">
                  <input
                    type="number"
                    step="1"
                    value={analysisSettings.north}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAnalysisSettings((s) => ({
                        ...s,
                        north: normalizeNumericInput(v, { min: -180, max: 180, fallback: 0 }),
                      }));
                    }}
                    onBlur={() => {
                      setAnalysisSettings((s) => ({
                        ...s,
                        north: normalizeOnBlur(s.north, { min: -180, max: 180, fallback: 0 }),
                      }));
                    }}
                  />
                  <span className="terrain-field-label">North (deg)</span>
                </label>
              </div>
            </div>

            <div
              className="terrain-controls-section terrain-charts"
              style={{ width: "100%", marginTop: 12 }}
            >
              <div className="terrain-charts-card">
                <div className="terrain-charts-header" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div className="terrain-charts-title">Sun Hours Distribution</div>
                  <div className="terrain-charts-subtitle" style={{ fontSize: 12, lineHeight: 1.25, opacity: 0.85 }}>
                    Run an analysis to generate a downloadable figure and raw data table.
                  </div>
                </div>

                <div className="terrain-charts-actions">
                  <button type="button" className="terrain-chart-btn" onClick={() => setChartsExpanded((v) => !v)}>
                    {chartsExpanded ? "Collapse Chart" : "Expand Chart"}
                  </button>
                  <button
                    type="button"
                    className="terrain-chart-btn"
                    disabled={!analysisResult}
                    onClick={() => {
                      if (!analysisResult) return;
                      const svg = buildSunHoursHistogramSvg(analysisResult, {
                        width: 980,
                        height: 280,
                      });
                      downloadTextFile("sun-hours-distribution.svg", svg, "image/svg+xml");
                    }}
                  >
                    Download SVG
                  </button>
                  <button
                    type="button"
                    className="terrain-chart-btn"
                    disabled={!analysisResult}
                    onClick={() => {
                      if (!analysisResult) return;
                      const csv = buildSunHoursCsv(analysisResult);
                      downloadTextFile("sun-hours.csv", csv, "text/csv");
                    }}
                  >
                    Download CSV
                  </button>
                </div>

                <div
                  className="terrain-charts-stage"
                  style={{ minHeight: chartsExpanded ? 420 : 220 }}
                >
                {analysisResult ? (
                  <div style={{ position: "relative", width: "100%", height: "100%" }}>
                    <img
                      alt="Sun Hours Distribution"
                      style={{ width: "100%", height: "100%", objectFit: "contain", cursor: "pointer" }}
                      onClick={() => setChartModalOpen(true)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setChartMenu({ x: e.clientX, y: e.clientY });
                      }}
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(
                        buildSunHoursHistogramSvg(analysisResult, {
                          width: 980,
                          height: chartsExpanded ? 420 : 240,
                        })
                      )}`}
                    />

                    {chartMenu ? (
                      <div
                        style={{
                          position: "fixed",
                          left: chartMenu.x,
                          top: chartMenu.y,
                          zIndex: 2000,
                          background: "#0b1220",
                          border: "1px solid rgba(148, 163, 184, 0.25)",
                          borderRadius: 10,
                          padding: 6,
                          minWidth: 180,
                          boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="terrain-chart-btn"
                          style={{ width: "100%", justifyContent: "flex-start" }}
                          onClick={() => {
                            setChartMenu(null);
                            setChartModalOpen(true);
                          }}
                        >
                          Open chart
                        </button>
                        <button
                          type="button"
                          className="terrain-chart-btn"
                          style={{ width: "100%", justifyContent: "flex-start" }}
                          onClick={() => {
                            if (!analysisResult) return;
                            setChartMenu(null);
                            const svg = buildSunHoursHistogramSvg(analysisResult, { width: 1200, height: 520 });
                            downloadTextFile("sun-hours-distribution.svg", svg, "image/svg+xml");
                          }}
                        >
                          Download SVG
                        </button>
                        <button
                          type="button"
                          className="terrain-chart-btn"
                          style={{ width: "100%", justifyContent: "flex-start" }}
                          onClick={() => {
                            if (!analysisResult) return;
                            setChartMenu(null);
                            const csv = buildSunHoursCsv(analysisResult);
                            downloadTextFile("sun-hours.csv", csv, "text/csv");
                          }}
                        >
                          Download CSV
                        </button>
                      </div>
                    ) : null}

                    {chartModalOpen ? (
                      <div
                        role="dialog"
                        aria-modal="true"
                        style={{
                          position: "fixed",
                          inset: 0,
                          zIndex: 1800,
                          background: "rgba(0,0,0,0.6)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 18,
                        }}
                        onMouseDown={() => setChartModalOpen(false)}
                      >
                        <div
                          style={{
                            width: "min(1200px, 96vw)",
                            height: "min(700px, 86vh)",
                            background: "#0b1220",
                            border: "1px solid rgba(148, 163, 184, 0.25)",
                            borderRadius: 14,
                            boxShadow: "0 16px 48px rgba(0,0,0,0.65)",
                            padding: 10,
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <div className="terrain-charts-title">Sun Hours Distribution</div>
                            <button type="button" className="terrain-chart-btn" onClick={() => setChartModalOpen(false)}>
                              Close
                            </button>
                          </div>
                          <div style={{ flex: 1, minHeight: 0 }}>
                            <img
                              alt="Sun Hours Distribution (expanded)"
                              style={{ width: "100%", height: "100%", objectFit: "contain" }}
                              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(
                                buildSunHoursHistogramSvg(analysisResult, { width: 1200, height: 600 })
                              )}`}
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="terrain-meta">Simulation results will appear here.</div>
                )}
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

type BBox = [number, number, number, number]; // [west, south, east, north]

export default function CesiumMap({
  onExportDxfBBox,
}: {
  onExportDxfBBox?: (bbox: BBox) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const lastAoiRef = useRef<Cesium.Rectangle | null>(null);
  const aoiEntityRef = useRef<Cesium.Entity | null>(null);
  const highlightEntityRef = useRef<Cesium.Entity | null>(null);
  const tractEntitiesRef = useRef<Map<string, Cesium.Entity>>(new Map());
  const selectedTractsRef = useRef<Set<string>>(new Set());

  const [drawAoiMode, setDrawAoiMode] = useState<boolean>(false);
  const drawAoiModeRef = useRef<boolean>(false);
  const clickDrawingRef = useRef<boolean>(false);
  const clickStartRef = useRef<Cesium.Cartographic | null>(null);
  const clickLastRef = useRef<Cesium.Cartographic | null>(null);

  const [places, setPlaces] = useState<{ GEOID: string; NAME: string }[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string>("");
  const [cityFilter, setCityFilter] = useState<string>("");
  const [webglError, setWebglError] = useState<string | null>(null);

  // keep ref in sync so Cesium event handlers see current mode
  useEffect(() => {
    drawAoiModeRef.current = drawAoiMode;
    if (!drawAoiMode) {
      clickDrawingRef.current = false;
      clickStartRef.current = null;
      clickLastRef.current = null;
      const viewer = viewerRef.current;
      if (viewer) viewer.scene.screenSpaceCameraController.enableInputs = true;
    }
  }, [drawAoiMode]);

  function safeRectangleFromDegrees(west: number, south: number, east: number, north: number): Cesium.Rectangle | null {
    if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(north)) {
      return null;
    }
    const w = Math.min(west, east);
    const e = Math.max(west, east);
    const s = Math.min(south, north);
    const n = Math.max(south, north);
    if (w === e || s === n) return null;
    return Cesium.Rectangle.fromDegrees(w, s, e, n);
  }

  useEffect(() => {
    if (!containerRef.current) return;

    (window as any).CESIUM_BASE_URL = process.env.NEXT_PUBLIC_CESIUM_BASE_URL || "/cesium";
    Cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN as string;

    let viewer: Cesium.Viewer;
    try {
      viewer = new Cesium.Viewer(containerRef.current, {
        timeline: false,
        animation: false,
        baseLayerPicker: false,
        geocoder: false,
        sceneModePicker: false,
        homeButton: false,
        navigationHelpButton: false,
        selectionIndicator: false,
        infoBox: false,
        scene3DOnly: false,
        sceneMode: Cesium.SceneMode.SCENE2D,
        mapProjection: new Cesium.WebMercatorProjection(),
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      });
    } catch (e: any) {
      setWebglError(String(e?.message || e));
      return;
    }

    viewerRef.current = viewer;

    // 2D defaults similar to web maps
    viewer.scene.screenSpaceCameraController.enableTilt = false;
    const ctrl = viewer.scene.screenSpaceCameraController;
    // Only allow translate (pan) on LEFT_DRAG and zoom on wheel
    ctrl.rotateEventTypes = [] as any;
    ctrl.lookEventTypes = [] as any;
    ctrl.tiltEventTypes = [] as any;
    ctrl.translateEventTypes = [Cesium.CameraEventType.LEFT_DRAG] as any;
    ctrl.zoomEventTypes = [Cesium.CameraEventType.WHEEL] as any;
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#d0d8ff');
    // Set initial view (Los Angeles area)
    const laRect = Cesium.Rectangle.fromDegrees(-119.2, 33.4, -117.2, 34.6);
    viewer.camera.setView({ destination: laRect });

    // prevent context menu on right click
    containerRef.current.addEventListener('contextmenu', (e) => e.preventDefault());

    // OSM Standard: classic style (roads + green areas), as in the reference
    const osm = new Cesium.UrlTemplateImageryProvider({
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      credit: new Cesium.Credit("© OpenStreetMap contributors"),
      maximumLevel: 19,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      subdomains: ["a", "b", "c"],
    });
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(osm);

    // AOI drawing / interactions
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    function toCartographicFromScreen(position: Cesium.Cartesian2): Cesium.Cartographic | null {
      const scene = viewer.scene;
      let cartesian: Cesium.Cartesian3 | undefined | null = undefined;

      // Primary approach: ray + intersection with the "globe"
      const ray = scene.camera.getPickRay(position);
      if (ray) {
        cartesian = scene.globe.pick(ray, scene);
      }

      // In 2D/WebMercator, pick may return null — fall back to camera.pickEllipsoid
      if (!cartesian) {
        cartesian = scene.camera.pickEllipsoid(
          position,
          Cesium.Ellipsoid.WGS84
        );
      }

      if (!cartesian) return null;
      return Cesium.Ellipsoid.WGS84.cartesianToCartographic(cartesian);
    }

    function rectangleFromTwoCarto(a: Cesium.Cartographic, b: Cesium.Cartographic): Cesium.Rectangle {
      const eps = 1e-8;
      let west = Math.min(a.longitude, b.longitude);
      let east = Math.max(a.longitude, b.longitude);
      let south = Math.min(a.latitude, b.latitude);
      let north = Math.max(a.latitude, b.latitude);
      if (east - west < eps) east = west + eps;
      if (north - south < eps) north = south + eps;
      return new Cesium.Rectangle(west, south, east, north);
    }

    function clampToMax3km(a: Cesium.Cartographic, b: Cesium.Cartographic): Cesium.Rectangle {
      const max = 3000.0; // 3 km max per axis

      // compute horizontal (E-W) distance at constant latitude = a.latitude
      const horizGeodesic = new Cesium.EllipsoidGeodesic(
        new Cesium.Cartographic(a.longitude, a.latitude),
        new Cesium.Cartographic(b.longitude, a.latitude)
      );

      // compute vertical (N-S) distance at constant longitude = a.longitude
      const vertGeodesic = new Cesium.EllipsoidGeodesic(
        new Cesium.Cartographic(a.longitude, a.latitude),
        new Cesium.Cartographic(a.longitude, b.latitude)
      );

      const dx = Math.abs(horizGeodesic.surfaceDistance);
      const dy = Math.abs(vertGeodesic.surfaceDistance);

      let lon = b.longitude;
      let lat = b.latitude;

      if (dx > max && dx > 0) {
        const ratioX = max / dx;
        lon = a.longitude + (b.longitude - a.longitude) * ratioX;
      }
      if (dy > max && dy > 0) {
        const ratioY = max / dy;
        lat = a.latitude + (b.latitude - a.latitude) * ratioY;
      }

      const eps = 1e-8;
      let west = Math.min(a.longitude, lon);
      let east = Math.max(a.longitude, lon);
      let south = Math.min(a.latitude, lat);
      let north = Math.max(a.latitude, lat);

      if (east - west < eps) east = west + eps;
      if (north - south < eps) north = south + eps;

      return new Cesium.Rectangle(west, south, east, north);
    }

    // Drag: update the second point from mouse position
    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (drawAoiModeRef.current) {
        if (!clickDrawingRef.current || !clickStartRef.current) return;
        const carto = toCartographicFromScreen(movement.endPosition);
        if (!carto) return;
        clickLastRef.current = carto;

        const makePreview = () => {
          if (clickStartRef.current && clickLastRef.current) {
            return clampToMax3km(clickStartRef.current, clickLastRef.current);
          }
          const fallback = safeRectangleFromDegrees(-180, -85, 180, 85);
          return fallback ?? Cesium.Rectangle.fromDegrees(-180, -85, 180, 85);
        };

        if (!aoiEntityRef.current) {
          aoiEntityRef.current = viewer.entities.add({
            name: "AOI",
            rectangle: {
              coordinates: new Cesium.CallbackProperty(makePreview, false),
              material: Cesium.Color.CYAN.withAlpha(0.2),
              outline: true,
              outlineColor: Cesium.Color.CYAN,
            },
          });
        } else if (aoiEntityRef.current.rectangle) {
          aoiEntityRef.current.rectangle.coordinates = new Cesium.CallbackProperty(makePreview, false);
        }
        return;
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // Click-to-draw mode: first click sets start, second click finalizes.
    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (!drawAoiModeRef.current) return;

      const carto = toCartographicFromScreen(movement.position);
      if (!carto) return;

      if (!clickDrawingRef.current) {
        clickDrawingRef.current = true;
        clickStartRef.current = carto;
        clickLastRef.current = carto;
        ctrl.enableInputs = false;
        return;
      }

      if (!clickStartRef.current) return;
      clickLastRef.current = carto;
      const rect = clampToMax3km(clickStartRef.current, carto);
      lastAoiRef.current = rect;

      if (!aoiEntityRef.current) {
        aoiEntityRef.current = viewer.entities.add({
          name: "AOI",
          rectangle: {
            coordinates: new Cesium.ConstantProperty(rect),
            material: Cesium.Color.CYAN.withAlpha(0.2),
            outline: true,
            outlineColor: Cesium.Color.CYAN,
          },
        });
      } else if (aoiEntityRef.current.rectangle) {
        aoiEntityRef.current.rectangle.coordinates = new Cesium.ConstantProperty(rect);
      }

      ctrl.enableInputs = true;
      clickDrawingRef.current = false;
      clickStartRef.current = null;
      clickLastRef.current = null;
      setDrawAoiMode(false);

      viewer.camera.flyTo({ destination: rect });

      const west = Cesium.Math.toDegrees(rect.west);
      const south = Cesium.Math.toDegrees(rect.south);
      const east = Cesium.Math.toDegrees(rect.east);
      const north = Cesium.Math.toDegrees(rect.north);

      try {
        if (typeof window !== "undefined" && window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "cadmapper:bbox", bbox: [west, south, east, north] }, "*");
        }
      } catch {
        // ignore
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Cleanup
    return () => {
      handler.destroy();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // Load cities (places) list for autocomplete
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/places");
        if (!res.ok) return;
        const items = await res.json();
        if (!cancelled) {
          setPlaces(items);
          if (items.length && !selectedPlaceId) {
            setSelectedPlaceId(items[0].GEOID);
            setCityFilter(items[0].NAME || "");
          }
        }
      } catch {
        // ignore
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function highlightCityByGeoid(geoid: string) {
    if (!viewerRef.current || !geoid) return;

    try {
      const res = await fetch(`/api/places?geoid=${encodeURIComponent(geoid)}`);
      if (!res.ok) return;
      const feature = await res.json();
      const geom = feature.geometry;
      if (!geom || !geom.type) return;

      const coords: number[][][] = [];
      if (geom.type === "Polygon") {
        coords.push(geom.coordinates[0]);
      } else if (geom.type === "MultiPolygon") {
        for (const poly of geom.coordinates) {
          if (poly[0]) coords.push(poly[0]);
        }
      } else return;

      const positions: Cesium.Cartesian3[] = [];
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;

      for (const ring of coords) {
        for (const [lon, lat] of ring) {
          positions.push(Cesium.Cartesian3.fromDegrees(lon, lat));
          west = Math.min(west, lon);
          south = Math.min(south, lat);
          east = Math.max(east, lon);
          north = Math.max(north, lat);
        }
      }
      if (!positions.length) return;

      const viewer = viewerRef.current;
      if (!viewer) return;

      // remove previous highlight
      if (highlightEntityRef.current) {
        viewer.entities.remove(highlightEntityRef.current);
        highlightEntityRef.current = null;
      }

      const entity = viewer.entities.add({
        name: `City ${geoid}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: Cesium.Color.ORANGE.withAlpha(0.25),
          outline: true,
          outlineColor: Cesium.Color.ORANGE,
        },
      });
      highlightEntityRef.current = entity;

      const rect = safeRectangleFromDegrees(west, south, east, north);
      if (!rect) return;
      lastAoiRef.current = rect;
      viewer.camera.flyTo({ destination: rect });
    } catch {
      // ignore
    }
  }

  async function highlightTractByGeoid(geoid: string) {
    if (!viewerRef.current || !geoid) return;

    try {
      const res = await fetch(`/api/tract-geom?geoid=${encodeURIComponent(geoid)}`);
      if (!res.ok) return;
      const feature = await res.json();
      const geom = feature.geometry;
      if (!geom || !geom.type) return;

      const coords: number[][][] = [];
      if (geom.type === "Polygon") {
        coords.push(geom.coordinates[0]);
      } else if (geom.type === "MultiPolygon") {
        for (const poly of geom.coordinates) {
          if (poly[0]) coords.push(poly[0]);
        }
      } else return;

      const positions: Cesium.Cartesian3[] = [];
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;

      for (const ring of coords) {
        for (const [lon, lat] of ring) {
          positions.push(Cesium.Cartesian3.fromDegrees(lon, lat));
          west = Math.min(west, lon);
          south = Math.min(south, lat);
          east = Math.max(east, lon);
          north = Math.max(north, lat);
        }
      }
      if (!positions.length) return;

      const viewer = viewerRef.current;
      if (!viewer) return;

      const entity = viewer.entities.add({
        name: `Tract ${geoid}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: Cesium.Color.LIME.withAlpha(0.25),
          outline: true,
          outlineColor: Cesium.Color.LIME,
        },
        properties: new Cesium.PropertyBag({
          kind: "tract",
          geoid,
        }),
      });
      tractEntitiesRef.current.set(geoid, entity);

      const rect = safeRectangleFromDegrees(west, south, east, north);
      if (!rect) return;
      viewer.camera.flyTo({ destination: rect });
    } catch {
      // ignore
    }
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {webglError ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            background: "rgba(0,0,0,0.7)",
            color: "rgba(255,255,255,0.95)",
            textAlign: "center",
          }}
        >
          <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>WebGL initialization failed</div>
            <div style={{ fontSize: 12, opacity: 0.9, lineHeight: 1.4 }}>
              This map requires WebGL. Please enable hardware acceleration in your browser or update GPU drivers, then
              reload the page.
            </div>
            <div style={{ fontSize: 11, opacity: 0.85, wordBreak: "break-word" }}>{webglError}</div>
          </div>
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          zIndex: 10,
          alignItems: "flex-end",
        }}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button
            onClick={() => setDrawAoiMode((v) => !v)}
            style={{
              padding: "8px 12px",
              background: drawAoiMode ? "#0f766e" : "#111827",
              color: "#fff",
              border: "1px solid #ffffff33",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            {drawAoiMode ? "Cencel" : "Area"}
          </button>

          <button
            onClick={async () => {
              const rect = lastAoiRef.current;
              if (!rect || !viewerRef.current) {
                alert("Сначала выделите область");
                return;
              }
              const west = Cesium.Math.toDegrees(rect.west);
              const south = Cesium.Math.toDegrees(rect.south);
              const east = Cesium.Math.toDegrees(rect.east);
              const north = Cesium.Math.toDegrees(rect.north);

              // Ensure parent (main UI) receives bbox even if AOI selection was made earlier.
              try {
                if (typeof window !== "undefined" && window.parent && window.parent !== window) {
                  window.parent.postMessage(
                    { type: "cadmapper:bbox", bbox: [west, south, east, north] },
                    "*"
                  );
                }
              } catch {
                // ignore
              }

              if (onExportDxfBBox) {
                onExportDxfBBox([west, south, east, north]);
              }

              const bboxParam = [west, south, east, north].join(",");
              const dxfUrl = `/api/export-dxf?bbox=${encodeURIComponent(bboxParam)}`;

              const a = document.createElement("a");
              a.href = dxfUrl;
              a.download = "export.dxf";
              a.rel = "noopener";
              document.body.appendChild(a);
              a.click();
              a.remove();
            }}
            style={{ padding: "8px 12px", background: "#111827", color: "#fff", border: "1px solid #ffffff33", borderRadius: 6, cursor: "pointer" }}
          >
            Export DXF
          </button>

          <button
            onClick={async () => {
              const rect = lastAoiRef.current;
              if (!rect || !viewerRef.current) {
                alert("Сначала выделите область");
                return;
              }
              const west = Cesium.Math.toDegrees(rect.west);
              const south = Cesium.Math.toDegrees(rect.south);
              const east = Cesium.Math.toDegrees(rect.east);
              const north = Cesium.Math.toDegrees(rect.north);

              try {
                if (typeof window !== "undefined" && window.parent && window.parent !== window) {
                  window.parent.postMessage(
                    { type: "cadmapper:bbox", bbox: [west, south, east, north] },
                    "*"
                  );
                }
              } catch {
                // ignore
              }
            }}
            style={{ padding: "8px 12px", background: "#111827", color: "#fff", border: "1px solid #ffffff33", borderRadius: 6, cursor: "pointer" }}
          >
            Analyze
          </button>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ fontSize: "0.75rem", color: "#111827", background: "#e5e7eb", padding: "4px 6px", borderRadius: 4 }}>
            City:
            <input
              list="city-list"
              value={cityFilter}
              onChange={async (e) => {
                const value = e.target.value;
                setCityFilter(value);
                const query = value.trim().toLowerCase();
                if (!query) return;
                const match =
                  places.find((p) => (p.NAME || "").toLowerCase() === query) ||
                  places.find((p) => (p.NAME || "").toLowerCase().includes(query));
                if (match) {
                  setSelectedPlaceId(match.GEOID);
                  await highlightCityByGeoid(match.GEOID);
                }
              }}
              placeholder="Type city name..."
              style={{ marginLeft: 4, fontSize: "0.75rem", padding: "4px 6px", borderRadius: 4, border: "1px solid #d1d5db" }}
            />
            <datalist id="city-list">
              {places.map((p) => (
                <option key={p.GEOID} value={p.NAME} />
              ))}
            </datalist>
          </label>
        </div>
      </div>
    </div>
  );
}

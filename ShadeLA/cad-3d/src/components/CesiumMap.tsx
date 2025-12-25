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
  const highlightEntityRef = useRef<Cesium.Entity | null>(null);
  const tractEntitiesRef = useRef<Map<string, Cesium.Entity>>(new Map());
  const selectedTractsRef = useRef<Set<string>>(new Set());
  const selectionModeRef = useRef<boolean>(true);

  const [places, setPlaces] = useState<{ GEOID: string; NAME: string }[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string>("");
  const [cityFilter, setCityFilter] = useState<string>("");
  const [selectionMode, setSelectionMode] = useState<boolean>(true);

  // keep ref in sync so Cesium event handlers see current mode
  useEffect(() => {
    selectionModeRef.current = selectionMode;
  }, [selectionMode]);

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

    const viewer = new Cesium.Viewer(containerRef.current, {
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

    viewerRef.current = viewer;

    // 2D defaults similar to web maps
    viewer.scene.screenSpaceCameraController.enableTilt = false;
    const ctrl = viewer.scene.screenSpaceCameraController;
    // Only allow translate (pan) on RIGHT_DRAG and zoom on wheel
    ctrl.rotateEventTypes = [] as any;
    ctrl.lookEventTypes = [] as any;
    ctrl.tiltEventTypes = [] as any;
    ctrl.translateEventTypes = [Cesium.CameraEventType.RIGHT_DRAG] as any;
    ctrl.zoomEventTypes = [Cesium.CameraEventType.WHEEL] as any;
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#d0d8ff');
    // Set initial view (Los Angeles area)
    const laRect = Cesium.Rectangle.fromDegrees(-119.2, 33.4, -117.2, 34.6);
    viewer.camera.setView({ destination: laRect });

    // prevent context menu on right click
    containerRef.current.addEventListener('contextmenu', (e) => e.preventDefault());

    // OSM Standard: классический стиль (дороги + зелёные зоны), как в референсе
    const osm = new Cesium.UrlTemplateImageryProvider({
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      credit: new Cesium.Credit("© OpenStreetMap contributors"),
      maximumLevel: 19,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      subdomains: ["a", "b", "c"],
    });
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(osm);

    // AOI drawing: rectangle with 10x10 km cap (drag-rectangle, как в v1)
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    let rectangleEntity: Cesium.Entity | null = null;
    let dragging = false;
    let startCarto: Cesium.Cartographic | null = null;

    function toCartographicFromScreen(position: Cesium.Cartesian2): Cesium.Cartographic | null {
      const scene = viewer.scene;
      let cartesian: Cesium.Cartesian3 | undefined | null = undefined;

      // Основной вариант: луч + пересечение с "глобусом"
      const ray = scene.camera.getPickRay(position);
      if (ray) {
        cartesian = scene.globe.pick(ray, scene);
      }

      // В 2D/WebMercator иногда pick даёт null — пробуем камеру по эллипсоиду
      if (!cartesian) {
        cartesian = scene.camera.pickEllipsoid(
          position,
          Cesium.Ellipsoid.WGS84
        );
      }

      if (!cartesian) return null;
      return Cesium.Ellipsoid.WGS84.cartesianToCartographic(cartesian);
    }

    function clampToMax10km(a: Cesium.Cartographic, b: Cesium.Cartographic): Cesium.Rectangle {
      const max = 10000.0; // 10 km максимум по каждой оси
      // compute horizontal (E-W) distance at constant latitude = a.lat
      const lonB = b.longitude;
      const latB = b.latitude;
      const horizGeodesic = new Cesium.EllipsoidGeodesic(
        new Cesium.Cartographic(a.longitude, a.latitude),
        new Cesium.Cartographic(lonB, a.latitude)
      );
      const vertGeodesic = new Cesium.EllipsoidGeodesic(
        new Cesium.Cartographic(a.longitude, a.latitude),
        new Cesium.Cartographic(a.longitude, latB)
      );
      const dx = Math.abs(horizGeodesic.surfaceDistance);
      const dy = Math.abs(vertGeodesic.surfaceDistance);

      let lon = lonB;
      let lat = latB;

      if (dx > max) {
        const signX = Math.sign(lonB - a.longitude) || 1;
        const ratioX = max / dx;
        lon = a.longitude + (lonB - a.longitude) * ratioX * signX;
      }
      if (dy > max) {
        const signY = Math.sign(latB - a.latitude) || 1;
        const ratioY = max / dy;
        lat = a.latitude + (latB - a.latitude) * ratioY * signY;
      }

      // Гарантируем корректный прямоугольник: east > west, north > south
      const eps = 1e-8;
      let west = Math.min(a.longitude, lon);
      let east = Math.max(a.longitude, lon);
      let south = Math.min(a.latitude, lat);
      let north = Math.max(a.latitude, lat);

      if (east - west < eps) {
        east = west + eps;
      }
      if (north - south < eps) {
        north = south + eps;
      }

      return new Cesium.Rectangle(west, south, east, north);
    }

    let lastCarto: Cesium.Cartographic | null = null;

    // Начало drag: запоминаем первую точку и создаём AOI-entity
    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const carto = toCartographicFromScreen(movement.position);
      startCarto = carto;
      dragging = !!carto;
      if (dragging) {
        lastCarto = carto;
        ctrl.enableInputs = false; // замораживаем камеру на время рисования

        const makePreviewCallback = () => {
          if (startCarto && lastCarto) {
            return clampToMax10km(startCarto, lastCarto);
          }
          const fallback = safeRectangleFromDegrees(-180, -85, 180, 85);
          return fallback ?? Cesium.Rectangle.fromDegrees(-180, -85, 180, 85);
        };

        if (!rectangleEntity) {
          rectangleEntity = viewer.entities.add({
            name: "AOI",
            rectangle: {
              coordinates: new Cesium.CallbackProperty(makePreviewCallback, false),
              material: Cesium.Color.CYAN.withAlpha(0.2),
              outline: true,
              outlineColor: Cesium.Color.CYAN,
            },
          });
        } else if (rectangleEntity.rectangle) {
          rectangleEntity.rectangle.coordinates = new Cesium.CallbackProperty(
            makePreviewCallback,
            false
          );
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    // Drag: обновляем вторую точку по мыши
    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!dragging || !startCarto) return;
      const carto = toCartographicFromScreen(movement.endPosition);
      if (!carto) return;
      lastCarto = carto;
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // Завершение drag: фиксируем прямоугольник и грузим OSM
    handler.setInputAction(() => {
      if (!dragging || !startCarto || !lastCarto) return;
      dragging = false;
      ctrl.enableInputs = true; // возвращаем управление камерой

      const rect = clampToMax10km(startCarto, lastCarto);

      if (!rectangleEntity) {
        rectangleEntity = viewer.entities.add({
          name: "AOI",
          rectangle: {
            coordinates: new Cesium.ConstantProperty(rect),
            material: Cesium.Color.CYAN.withAlpha(0.2),
            outline: true,
            outlineColor: Cesium.Color.CYAN,
          },
        });
      } else if (rectangleEntity.rectangle) {
        rectangleEntity.rectangle.coordinates = new Cesium.ConstantProperty(rect);
      }

      const widthDeg = Cesium.Math.toDegrees(rect.east - rect.west);
      const heightDeg = Cesium.Math.toDegrees(rect.north - rect.south);
      const tooBig = widthDeg > 120 || heightDeg > 120;
      if (!tooBig) {
        viewer.camera.flyTo({ destination: rect });
        lastAoiRef.current = rect;
      }

      const west = Cesium.Math.toDegrees(rect.west);
      const south = Cesium.Math.toDegrees(rect.south);
      const east = Cesium.Math.toDegrees(rect.east);
      const north = Cesium.Math.toDegrees(rect.north);

      // Notify parent window (when embedded via iframe) about the latest bbox
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

      fetch("/api/osm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox: [west, south, east, north] }),
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(await r.text());
          return r.json();
        })
        .then(async (geojson) => {
          const existing = viewer.dataSources.getByName("buildings")[0];
          if (existing) viewer.dataSources.remove(existing, true);

          const ds = await Cesium.GeoJsonDataSource.load(geojson, {
            clampToGround: false,
          });
          ds.name = "buildings";
          viewer.dataSources.add(ds);

          const entities = ds.entities.values;
          for (const ent of entities) {
            const poly = ent.polygon as Cesium.PolygonGraphics | undefined;
            const line = ent.polyline as Cesium.PolylineGraphics | undefined;
            const pt = ent.point as Cesium.PointGraphics | undefined;
            const billboard = ent.billboard as Cesium.BillboardGraphics | undefined;
            const label = ent.label as Cesium.LabelGraphics | undefined;

            // Полностью отключаем точечные маркеры OSM (никаких синих пинов)
            if (pt) {
              pt.show = new Cesium.ConstantProperty(false);
            }
            if (billboard) {
              billboard.show = new Cesium.ConstantProperty(false);
            }
            if (label) {
              label.show = new Cesium.ConstantProperty(false);
            }

            // Делаем дороги более похожими на Google Maps по толщине/цвету
            if (line) {
              const p: any = ent.properties?.getValue(Cesium.JulianDate.now()) || {};
              const hwy = String(p.highway || "").toLowerCase();

              let w = 1.5;
              let c = Cesium.Color.fromCssColorString("#c0c4cc").withAlpha(0.95);

              if (hwy === "motorway" || hwy === "trunk") {
                w = 4.0;
                c = Cesium.Color.fromCssColorString("#ff9800").withAlpha(0.95);
              } else if (hwy === "primary" || hwy === "secondary") {
                w = 3.0;
                c = Cesium.Color.fromCssColorString("#ffd54f").withAlpha(0.95);
              } else if (hwy === "tertiary" || hwy === "residential" || hwy === "unclassified" || hwy === "living_street") {
                w = 2.0;
                c = Cesium.Color.fromCssColorString("#e0e0e0").withAlpha(0.95);
              } else if (hwy === "service") {
                w = 1.5;
                c = Cesium.Color.fromCssColorString("#d0d0d0").withAlpha(0.9);
              } else if (hwy === "footway" || hwy === "path" || hwy === "steps" || hwy === "cycleway" || hwy === "track") {
                w = 1.0;
                c = Cesium.Color.fromCssColorString("#a5d6a7").withAlpha(0.9);
              }

              line.width = new Cesium.ConstantProperty(w);
              line.material = new Cesium.ColorMaterialProperty(c);
            }

            if (!poly) continue;

            const p: any = ent.properties?.getValue(Cesium.JulianDate.now()) || {};
            let h = 0;
            if (p.height) {
              const parsed = parseFloat(String(p.height));
              if (!isNaN(parsed)) h = parsed;
            } else if (p["building:height"]) {
              const parsed = parseFloat(String(p["building:height"]));
              if (!isNaN(parsed)) h = parsed;
            } else if (p.levels || p["building:levels"]) {
              const lv = parseFloat(String(p.levels || p["building:levels"])) || 0;
              h = lv * 3.0;
            } else {
              h = 10.0;
            }

            const color = Cesium.Color.fromRandom({ alpha: 0.6 });
            poly.material = new Cesium.ColorMaterialProperty(color);
            poly.outline = new Cesium.ConstantProperty(true);
            poly.outlineColor = new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(0.4));
            poly.height = new Cesium.ConstantProperty(0);
            poly.extrudedHeight = new Cesium.ConstantProperty(h);
          }
        })
        .catch((err) => {
          // basic error logging in console
          // eslint-disable-next-line no-console
          console.error("OSM fetch failed", err);
        });
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    // Cleanup
    return () => {
      handler.destroy();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // Загрузка списка городов (places) для автодополнения
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
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setSelectionMode((v) => !v)}
            style={{
              padding: "4px 8px",
              fontSize: "0.75rem",
              borderRadius: 4,
              border: "1px solid #d1d5db",
              background: selectionMode ? "#111827" : "#e5e7eb",
              color: selectionMode ? "#ffffff" : "#111827",
              cursor: "pointer",
            }}
          >
            {selectionMode ? "Selection: ON" : "Selection: OFF"}
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

        <div style={{ display: "flex", gap: 8 }}>
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

            // Reliable downloads inside iframe: trigger direct GET navigations.
            const bboxParam = [west, south, east, north].join(",");
            const dxfUrl = `/api/export-dxf?bbox=${encodeURIComponent(bboxParam)}`;

            const clickDownload = (url: string, filename: string) => {
              const a = document.createElement("a");
              a.href = url;
              a.download = filename;
              a.rel = "noopener";
              document.body.appendChild(a);
              a.click();
              a.remove();
            };

            clickDownload(dxfUrl, "export.dxf");
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
            const bboxParam = [west, south, east, north].join(",");
            const url = `/api/export-3dm-compute?bbox=${encodeURIComponent(bboxParam)}`;
            const a = document.createElement("a");
            a.href = url;
            a.download = "export_3dm.3dm";
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
          }}
          style={{ padding: "8px 12px", background: "#111827", color: "#fff", border: "1px solid #ffffff33", borderRadius: 6, cursor: "pointer" }}
        >
          Export 3DM
        </button>
        </div>
      </div>
    </div>
  );
}

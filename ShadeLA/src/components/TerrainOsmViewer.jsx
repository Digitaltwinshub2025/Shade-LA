import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { fetchDemWithFallback } from "../terrain-osm/api.js";
import { createGeoReference } from "../terrain-osm/geo.js";
import {
  applyVerticalExaggeration,
  createTerrainMesh,
  parseGeoTiff,
  updateTerrainMaterial,
} from "../terrain-osm/terrain.js";
import { createBuildingGroup, disposeBuildingGroup, fetchBuildingsGeoJson, updateBuildingDisplay } from "../terrain-osm/buildings.js";
import { createRoadGroup, disposeRoadGroup, fetchRoadGeoJson, updateRoadDisplay } from "../terrain-osm/roads.js";
import {
  createSunHoursOverlay,
  disposeSunHoursOverlay,
  updateSunHoursOverlay,
} from "../terrain-osm/analysis-visualize.js";
import { runDirectSunHoursAnalysis, runMeshFromPolylines } from "../terrain-osm/analysis-api.js";
import { sampleAnalysisColor } from "../terrain-osm/analysis-colors.js";

function clampNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
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

function defaultBounds() {
  return {
    minLon: -118.326047,
    minLat: 34.077448,
    maxLon: -118.320577,
    maxLat: 34.082834,
  };
}

const TerrainOsmViewer = forwardRef(function TerrainOsmViewer({ options, onStatus }, ref) {
  const apiKey = import.meta.env.VITE_OPENTOPO_API_KEY;

  const SHADE_TARGET_MAX_DIM_METERS = 20;

  const shadePresetsRef = useRef(new Map());
  const [shadePresetsLoadError, setShadePresetsLoadError] = useState(null);
  const [shadePresetsUiNonce, setShadePresetsUiNonce] = useState(0);

  const [webglInitError, setWebglInitError] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateStatusText, setGenerateStatusText] = useState("");

  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const ambientLightRef = useRef(null);
  const sunLightRef = useRef(null);
  const sunTargetRef = useRef(null);

  const terrainStateRef = useRef(null);
  const geoRefRef = useRef(null);
  const buildingFeaturesRef = useRef(null);
  const buildingGroupRef = useRef(null);
  const roadGroupRef = useRef(null);
  const analysisOverlayRef = useRef(null);
  const meshOverlayRef = useRef(null);
  const sunPathGroupRef = useRef(null);
  const generationIdRef = useRef(0);

  const shadeGroupRef = useRef(null);
  const shadeInstancesRef = useRef([]);
  const shadePresetCacheRef = useRef(new Map());
  const selectedShadeRef = useRef(null);
  const dragShadeRef = useRef(null);
  const carryShadeRef = useRef(null);
  const onShadesChangedRef = useRef(null);

  const [shadeUiInstances, setShadeUiInstances] = useState([]);
  const [selectedShadeUi, setSelectedShadeUi] = useState(null);
  const [selectedShadeMenuPos, setSelectedShadeMenuPos] = useState(null);
  const [shadeDropdownSelectedId, setShadeDropdownSelectedId] = useState("");
  const [shadeScaleDraft, setShadeScaleDraft] = useState("");
  const shadeMenuRef = useRef(null);

  const toolbarRef = useRef(null);
  const [toolbarBottomPx, setToolbarBottomPx] = useState(72);

  const [analysisLegend, setAnalysisLegend] = useState(null);

  const presetThumbErrorRef = useRef(new Set());
  const [presetThumbNonce, setPresetThumbNonce] = useState(0);

  const selectedBuildingRef = useRef(null);
  const [selectedBuildingUi, setSelectedBuildingUi] = useState(null);
  const [selectedBuildingHeight, setSelectedBuildingHeight] = useState(0);
  const [selectedBuildingMenuPos, setSelectedBuildingMenuPos] = useState(null);
  const modifiedBuildingsRef = useRef(new Map());
  const [modifiedBuildingsUi, setModifiedBuildingsUi] = useState([]);

  const SHADE_GROUND_CLEARANCE_METERS = 0.05;
  const SHADE_SCALE_MIN = 0.001;
  const SHADE_SCALE_MAX = 100000;

  const [drawMode, setDrawMode] = useState(false);
  const drawModeRef = useRef(false);
  const [drawStatus, setDrawStatus] = useState("");
  const [, forceDrawUiUpdate] = useState(0);
  const drawGroupRef = useRef(null);
  const drawStateRef = useRef({ polylines: [], current: [] });
  const currentLineRef = useRef(null);
  const previewLineRef = useRef(null);

  const clearSelectedShade = () => {
    selectedShadeRef.current = null;
    carryShadeRef.current = null;
    setSelectedShadeUi(null);
    setSelectedShadeMenuPos(null);
    setShadeScaleDraft("");
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    if (!selectedShadeUi || !selectedShadeMenuPos) return;

    const clampMenuToMount = () => {
      const menuEl = shadeMenuRef.current;
      const mountRect = mount.getBoundingClientRect();
      const mountW = Math.max(1, mountRect.width);
      const mountH = Math.max(1, mountRect.height);
      const menuW = Math.max(1, menuEl?.offsetWidth ?? 240);
      const menuH = Math.max(1, menuEl?.offsetHeight ?? 160);

      const pad = 8;
      const yOffset = 14;

      const minX = menuW / 2 + pad;
      const maxX = mountW - menuW / 2 - pad;
      const minY = menuH + yOffset + pad;
      const maxY = mountH - pad;

      const nextX = clampNumber(selectedShadeMenuPos.x, minX, maxX);
      const nextY = clampNumber(selectedShadeMenuPos.y, minY, maxY);

      setSelectedShadeMenuPos((prev) => {
        if (!prev) return prev;
        const dx = Math.abs(prev.x - nextX);
        const dy = Math.abs(prev.y - nextY);
        if (dx < 0.5 && dy < 0.5) return prev;
        return { x: nextX, y: nextY };
      });
    };

    clampMenuToMount();
    window.addEventListener("resize", clampMenuToMount);
    return () => window.removeEventListener("resize", clampMenuToMount);
  }, [selectedShadeUi, selectedShadeMenuPos]);

  const parseUserNumber = (raw) => {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    const normalized = s.replace(",", ".");
    const n = Number(normalized);
    if (!Number.isFinite(n)) return null;
    return n;
  };

  useEffect(() => {
    if (!selectedShadeUi?.id) {
      setShadeScaleDraft("");
      return;
    }
    const v = Number(selectedShadeUi.scale ?? 1);
    setShadeScaleDraft(Number.isFinite(v) ? String(v) : "1");
  }, [selectedShadeUi?.id]);

  useEffect(() => {
    const update = () => {
      const el = toolbarRef.current;
      const h = el?.offsetHeight;
      if (!h) return;
      setToolbarBottomPx(10 + h + 10);
    };

    update();

    let ro;
    try {
      if (typeof ResizeObserver !== "undefined" && toolbarRef.current) {
        ro = new ResizeObserver(() => update());
        ro.observe(toolbarRef.current);
      }
    } catch {
      // ignore
    }

    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      try {
        ro?.disconnect?.();
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        setShadePresetsLoadError(null);
        const baseUrl = import.meta.env.BASE_URL || "/";
        const resp = await fetch(`${baseUrl}3dmodels/manifest.json`, { cache: "no-store" });
        if (!resp.ok) {
          throw new Error(`manifest fetch failed: ${resp.status}`);
        }
        const json = await resp.json();
        const raw = Array.isArray(json?.models) ? json.models : [];
        const models = raw
          .map((x) => String(x || "").trim())
          .filter(Boolean)
          .filter((x) => !x.startsWith("/") && !x.includes(".."));

        const next = new Map();
        for (const filename of models) {
          const id = filename;
          const displayLabel = filename.replace(/\.[^/.]+$/, "");
          next.set(id, {
            id,
            label: displayLabel,
            objUrl: `${baseUrl}3dmodels/${encodeURIComponent(filename)}`,
            defaultCoolingFactor: 0.1,
            defaultScale: 5,
            defaultRotationY: 0,
          });
        }

        if (!alive) return;
        shadePresetsRef.current = next;
        setShadePresetsUiNonce((x) => x + 1);
      } catch (e) {
        if (!alive) return;
        setShadePresetsLoadError(String(e?.message || e));
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  const clearMeshOverlay = () => {
    const scene = sceneRef.current;
    const overlay = meshOverlayRef.current;
    if (!scene || !overlay) return;
    scene.remove(overlay);
    clearGroup(overlay);
    overlay.clear();
    meshOverlayRef.current = null;
  };

  const applyMeshOverlay = (mesh) => {
    const scene = sceneRef.current;
    if (!scene) return;

    const vertices = mesh?.vertices;
    const faces = mesh?.faces;
    if (!Array.isArray(vertices) || !Array.isArray(faces) || vertices.length < 3 || faces.length < 1) {
      throw new Error("Mesh payload is empty");
    }

    clearMeshOverlay();

    const overlayGroup = new THREE.Group();
    overlayGroup.name = "polyline-mesh-overlay";
    overlayGroup.renderOrder = 35;

    const pos = new Float32Array(vertices.length * 3);
    for (let i = 0; i < vertices.length; i += 1) {
      const v = vertices[i];
      pos[i * 3 + 0] = Number(v?.[0] ?? 0);
      pos[i * 3 + 1] = Number(v?.[1] ?? 0) + 0.06;
      pos[i * 3 + 2] = Number(v?.[2] ?? 0);
    }

    const vCount = vertices.length;
    const out = [];
    const pushTri = (aRaw, bRaw, cRaw) => {
      const a = Number(aRaw);
      const b = Number(bRaw);
      const c = Number(cRaw);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return;
      const ai = Math.trunc(a);
      const bi = Math.trunc(b);
      const ci = Math.trunc(c);
      if (ai < 0 || bi < 0 || ci < 0) return;
      if (ai >= vCount || bi >= vCount || ci >= vCount) return;
      if (ai === bi || bi === ci || ci === ai) return;
      out.push(ai, bi, ci);
    };

    if (faces.length >= 3 && typeof faces[0] === "number") {
      for (let i = 0; i + 2 < faces.length; i += 3) {
        pushTri(faces[i], faces[i + 1], faces[i + 2]);
      }
    } else {
      for (let i = 0; i < faces.length; i += 1) {
        const f = faces[i];
        pushTri(f?.[0], f?.[1], f?.[2]);
      }
    }

    if (out.length < 3) {
      throw new Error("Mesh faces are invalid");
    }

    const index = new Uint32Array(out);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.35,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false;
    m.receiveShadow = true;
    m.renderOrder = 35;
    overlayGroup.add(m);

    overlayGroup.scale.y = displayOptions.exaggeration;
    meshOverlayRef.current = overlayGroup;
    scene.add(overlayGroup);
  };
  const raycasterRef = useRef(new THREE.Raycaster());

  const [shadowOverlayEnabled, setShadowOverlayEnabled] = useState(false);
  const [sunUiDate, setSunUiDate] = useState(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  });
  const [sunUiMinutes, setSunUiMinutes] = useState(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  });

  const clampAngleDegrees = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    let out = n;
    while (out <= -180) out += 360;
    while (out > 180) out -= 360;
    return out;
  };

  const parseDate = (value) => {
    if (!value) return null;
    const [y, m, d] = String(value).split("-").map((part) => Number(part));
    if (![y, m, d].every((v) => Number.isFinite(v))) return null;
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  };

  const addDaysUtc = (date, days) => {
    const out = new Date(date.getTime());
    out.setUTCDate(out.getUTCDate() + days);
    return out;
  };

  const manualSolarPosition = (latitude, longitude, momentUtc) => {
    const dayOfYear =
      Math.floor((Date.UTC(momentUtc.getUTCFullYear(), momentUtc.getUTCMonth(), momentUtc.getUTCDate()) -
        Date.UTC(momentUtc.getUTCFullYear(), 0, 0)) /
        86400000) || 1;
    const fractionalHour = momentUtc.getUTCHours() + momentUtc.getUTCMinutes() / 60;
    const declination =
      (23.45 * Math.sin(((360 / 365) * (284 + dayOfYear) * Math.PI) / 180) * Math.PI) / 180;
    const hourAngle = ((15 * (fractionalHour - 12)) * Math.PI) / 180;
    const latitudeRad = (latitude * Math.PI) / 180;

    const altitude = Math.asin(
      Math.sin(latitudeRad) * Math.sin(declination) +
        Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle)
    );

    const azimuth = Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(latitudeRad) - Math.tan(declination) * Math.cos(latitudeRad)
    );

    const altitudeDeg = (altitude * 180) / Math.PI;
    const azimuthFromNorth = ((azimuth * 180) / Math.PI + 180) % 360;
    return { altitudeDeg, azimuthDeg: azimuthFromNorth };
  };

  const parseIsoDate = (value) => {
    if (!value || typeof value !== "string") return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (![year, month, day].every((n) => Number.isFinite(n))) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    return { year, month, day };
  };

  const computeSunDirectionForUi = () => {
    const b = boundsRef.current;
    if (!b) return null;
    const latitude = (b.minLat + b.maxLat) / 2;
    const longitude = (b.minLon + b.maxLon) / 2;

    const parsed = parseIsoDate(sunUiDate);
    if (!parsed) return null;

    const minutes = clampNumber(sunUiMinutes, 0, 1439);
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const momentUtc = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, hour, minute, 0));

    const { altitudeDeg, azimuthDeg } = manualSolarPosition(latitude, longitude, momentUtc);
    if (!Number.isFinite(altitudeDeg) || !Number.isFinite(azimuthDeg) || altitudeDeg <= 0) {
      return {
        direction: new THREE.Vector3(0, 1, 0),
        momentUtc,
        aboveHorizon: false,
        altitudeDeg: Number.isFinite(altitudeDeg) ? altitudeDeg : -90,
      };
    }

    const altitudeRad = (altitudeDeg * Math.PI) / 180;
    const azimuthRad = (azimuthDeg * Math.PI) / 180;
    const horizontal = Math.cos(altitudeRad);
    const direction = new THREE.Vector3(
      Math.sin(azimuthRad) * horizontal,
      Math.sin(altitudeRad),
      -Math.cos(azimuthRad) * horizontal
    ).normalize();

    return { direction, momentUtc, aboveHorizon: true, altitudeDeg };
  };

  const getSceneBoundsForShadows = () => {
    const terrain = terrainStateRef.current?.mesh;
    if (!terrain) return null;

    const box = new THREE.Box3().setFromObject(terrain);
    if (buildingGroupRef.current) {
      box.union(new THREE.Box3().setFromObject(buildingGroupRef.current));
    }
    if (shadeGroupRef.current) {
      box.union(new THREE.Box3().setFromObject(shadeGroupRef.current));
    }
    return box;
  };

  const configureShadowCamera = (light, box) => {
    if (!light?.shadow?.camera || !box) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const radius = Math.max(size.x, size.z, 1) * 0.65;
    const cam = light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 0.1;
    cam.far = Math.max(2000, size.y * 6 + radius * 3);
    cam.updateProjectionMatrix();

    light.shadow.bias = -0.00015;
    light.shadow.normalBias = 0.02;
  };

  const updateSunAndShadows = () => {
    const scene = sceneRef.current;
    const light = sunLightRef.current;
    const target = sunTargetRef.current;
    const renderer = rendererRef.current;
    const ambient = ambientLightRef.current;
    if (!scene || !light || !target || !renderer) return;

    if (!shadowOverlayEnabled) {
      renderer.shadowMap.enabled = false;
      light.castShadow = false;

      if (ambient) {
        ambient.intensity = 1.05;
      }
      light.intensity = 2.0;
      return;
    }

    const sun = computeSunDirectionForUi();
    const aboveHorizon = !!sun?.aboveHorizon;
    const altitudeDeg = Number(sun?.altitudeDeg);
    const clampedAlt = Number.isFinite(altitudeDeg) ? clampNumber(altitudeDeg, -15, 15) : -15;
    const dayFactor = aboveHorizon ? clampNumber(clampedAlt / 10, 0, 1) : 0;

    // Lighting levels: keep a small ambient at night; ramp up smoothly after sunrise.
    if (ambient) {
      ambient.intensity = 1.05 * (0.12 + 0.88 * dayFactor);
    }
    light.intensity = 2.0 * (0.05 + 0.95 * dayFactor);

    const shadowsActive = aboveHorizon;
    renderer.shadowMap.enabled = shadowsActive;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    light.castShadow = shadowsActive;

    const box = getSceneBoundsForShadows();
    if (!box) return;

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const dir = sun?.direction ?? new THREE.Vector3(0, 1, 0);
    const distance = Math.max(size.x, size.z, 1) * 1.8 + Math.max(size.y, 1) * 2.0;

    target.position.copy(center);
    light.position.copy(center).addScaledVector(dir, distance);

    if (shadowsActive) {
      light.shadow.mapSize.set(2048, 2048);
      configureShadowCamera(light, box);
    }
  };

  const generateSunDirections = ({ latitude, longitude, analysisPeriod, timestepMinutes, northDegrees }) => {
    const startDate = parseDate(analysisPeriod?.start_date);
    const endDate = parseDate(analysisPeriod?.end_date);
    if (!startDate || !endDate) return [];

    const startHour = clampNumber(analysisPeriod?.start_hour ?? 0, 0, 23);
    const endHour = clampNumber(analysisPeriod?.end_hour ?? 23, 0, 23);
    const stepHours = clampNumber(Number(timestepMinutes) / 60, 1 / 60, 12);
    const north = clampAngleDegrees(northDegrees ?? 0);

    const out = [];
    for (let day = new Date(startDate.getTime()); day <= endDate; day = addDaysUtc(day, 1)) {
      for (let hour = startHour; hour <= endHour + 1e-9; hour += stepHours) {
        const wholeHour = Math.floor(hour);
        const minute = Math.round((hour - wholeHour) * 60);
        const moment = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), wholeHour, minute, 0));
        const { altitudeDeg, azimuthDeg } = manualSolarPosition(latitude, longitude, moment);
        if (altitudeDeg <= 0) continue;

        const altitudeRad = (altitudeDeg * Math.PI) / 180;
        const azimuthRad = ((azimuthDeg + north) * Math.PI) / 180;
        const horizontal = Math.cos(altitudeRad);
        const direction = new THREE.Vector3(
          Math.sin(azimuthRad) * horizontal,
          Math.sin(altitudeRad),
          -Math.cos(azimuthRad) * horizontal
        ).normalize();
        out.push({ direction, moment });
      }
    }
    return out;
  };

  const clearSunPath = () => {
    const scene = sceneRef.current;
    const group = sunPathGroupRef.current;
    if (!scene || !group) return;
    scene.remove(group);
    group.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => m.dispose?.());
      }
    });
    sunPathGroupRef.current = null;
  };

  const showSunPath = (settings) => {
    const scene = sceneRef.current;
    const terrainState = terrainStateRef.current;
    if (!scene || !terrainState?.mesh) {
      throw new Error("Generate terrain before showing sun path.");
    }

    const currentBounds = boundsRef.current;
    const latitude = (currentBounds.minLat + currentBounds.maxLat) / 2;
    const longitude = (currentBounds.minLon + currentBounds.maxLon) / 2;

    const vectors = generateSunDirections({
      latitude,
      longitude,
      analysisPeriod: settings?.analysisPeriod,
      timestepMinutes: settings?.timestep,
      northDegrees: settings?.north,
    });

    if (!vectors.length) {
      throw new Error("Sun path has no sun positions for the selected period.");
    }

    clearSunPath();

    const box = new THREE.Box3().setFromObject(terrainState.mesh);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const radius = Math.max(size.x, size.z, 1) * 0.55;
    const baseY = center.y + Math.max(size.y, 1) + radius * 0.25;

    const group = new THREE.Group();
    group.name = "sun-path";
    group.renderOrder = 15;

    const positions = new Float32Array(vectors.length * 3);
    for (let i = 0; i < vectors.length; i += 1) {
      const p = center.clone().setY(baseY).addScaledVector(vectors[i].direction, radius);
      positions[i * 3 + 0] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(lineGeo, lineMat);
    line.frustumCulled = false;

    const dotsGeo = new THREE.BufferGeometry();
    dotsGeo.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
    const dotsMat = new THREE.PointsMaterial({ color: 0xfef3c7, size: Math.max(1, radius * 0.012), sizeAttenuation: true });
    const dots = new THREE.Points(dotsGeo, dotsMat);
    dots.frustumCulled = false;

    group.add(line);
    group.add(dots);
    sunPathGroupRef.current = group;
    scene.add(group);
  };

  const [bounds, setBounds] = useState(() => defaultBounds());
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  const [localOptions, setLocalOptions] = useState(() => options ?? {});

  const generateRef = useRef(null);

  useEffect(() => {
    if (options && typeof options === "object") {
      setLocalOptions(options);
    }
  }, [options]);

  const displayOptions = useMemo(
    () => ({
      showTerrain: !!localOptions?.showTerrain,
      exaggeration: clampNumber(localOptions?.exaggeration ?? 1, 0, 20),
      wireframe: !!localOptions?.wireframe,
      colorMode: localOptions?.colorMode ?? "ramp",
      hillshadeEnabled: localOptions?.hillshadeEnabled ?? true,
    }),
    [localOptions]
  );

  const buildingOptions = useMemo(
    () => ({
      showBuildings: !!localOptions?.showBuildings,
      defaultFloorHeight: clampNumber(localOptions?.defaultFloorHeight ?? 3.2, 1, 10),
      defaultBuildingHeight: clampNumber(localOptions?.defaultBuildingHeight ?? 12, 1, 200),
      opacity: clampNumber(localOptions?.buildingOpacity ?? 1, 0, 1),
      exaggeration: clampNumber(localOptions?.exaggeration ?? 1, 0, 20),
    }),
    [localOptions]
  );

  const roadOptions = useMemo(
    () => ({
      showRoads: !!localOptions?.showRoads,
      widthScale: clampNumber(localOptions?.roadWidthScale ?? 1, 0.1, 8),
      opacity: clampNumber(localOptions?.roadOpacity ?? 0.7, 0, 1),
      exaggeration: clampNumber(localOptions?.exaggeration ?? 1, 0, 20),
    }),
    [localOptions]
  );

  function reportStatus(message) {
    try {
      const raw = String(message || "");
      const sanitized = (() => {
        if (!raw) return "";
        if (/https?:\/\//i.test(raw)) {
          if (/requesting/i.test(raw)) return "Requesting DEM...";
          return "Loading city model...";
        }
        return raw;
      })();
      setGenerateStatusText(sanitized);
    } catch {
      // ignore
    }
    if (typeof onStatus === "function") onStatus(message);
  }

  const clearSelectedBuilding = () => {
    const current = selectedBuildingRef.current;
    if (current?.mesh && current.originalMaterial) {
      try {
        current.mesh.material = current.originalMaterial;
      } catch {
        // ignore
      }
    }

    selectedBuildingRef.current = null;
    setSelectedBuildingUi(null);
    setSelectedBuildingHeight(0);
    setSelectedBuildingMenuPos(null);
  };

  const syncModifiedBuildingsUi = () => {
    const entries = Array.from(modifiedBuildingsRef.current.values());
    entries.sort((a, b) => {
      const ak = String(a.label ?? a.key ?? "");
      const bk = String(b.label ?? b.key ?? "");
      return ak.localeCompare(bk);
    });
    setModifiedBuildingsUi(entries);
  };

  const getBuildingKey = (meta) => {
    return (
      meta?.key ??
      meta?.feature?.id ??
      meta?.feature?.properties?.["@id"] ??
      meta?.feature?.properties?.id ??
      meta?.feature?.properties?.osm_id ??
      null
    );
  };

  const getBuildingLabel = (meta) => {
    const props = meta?.feature?.properties;
    const street = props?.["addr:street"] ?? props?.street;
    const house = props?.["addr:housenumber"] ?? props?.housenumber;
    const city = props?.["addr:city"] ?? props?.city;
    const postcode = props?.["addr:postcode"] ?? props?.postcode;

    const streetStr = street !== null && street !== undefined ? String(street).trim() : "";
    const houseStr = house !== null && house !== undefined ? String(house).trim() : "";
    if (streetStr || houseStr) {
      const base = `${streetStr}${streetStr && houseStr ? " " : ""}${houseStr}`.trim();
      const suffix = [
        city !== null && city !== undefined ? String(city).trim() : "",
        postcode !== null && postcode !== undefined ? String(postcode).trim() : "",
      ]
        .filter(Boolean)
        .join(" ")
        .trim();

      return suffix ? `${base}, ${suffix}` : base;
    }

    const key = getBuildingKey(meta);
    if (!key) return "Building";
    const parts = String(key).split(/[/:]/g).filter(Boolean);
    const last = parts[parts.length - 1] ?? String(key);
    return `Building №${last}`;
  };

  const getMeshWorldAnchor = (mesh) => {
    if (!mesh) return null;
    if (!mesh.geometry?.boundingBox) {
      try {
        mesh.geometry?.computeBoundingBox?.();
      } catch {
        // ignore
      }
    }
    const bbox = mesh.geometry?.boundingBox;
    if (!bbox) return null;
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    return mesh.localToWorld(center);
  };

  const projectWorldToScreen = (world) => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const mount = mountRef.current;
    if (!camera || !renderer || !mount || !world) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const mountRect = mount.getBoundingClientRect();
    const v = world.clone().project(camera);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return null;

    const px = ((v.x + 1) / 2) * rect.width + (rect.left - mountRect.left);
    const py = ((-v.y + 1) / 2) * rect.height + (rect.top - mountRect.top);

    return { x: px, y: py };
  };

  const highlightSelectedBuilding = (mesh) => {
    if (!mesh) return;

    const baseMaterial = mesh.material;
    const highlight = baseMaterial?.clone ? baseMaterial.clone() : new THREE.MeshStandardMaterial({ color: 0xffd166 });
    try {
      if ("emissive" in highlight) {
        highlight.emissive = new THREE.Color(0x22c55e);
        highlight.emissiveIntensity = 0.45;
      }
      highlight.needsUpdate = true;
    } catch {
      // ignore
    }

    mesh.material = highlight;
  };

  const pickBuildingAtEvent = (ev) => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const group = buildingGroupRef.current;
    if (!camera || !renderer || !group) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    const ndc = new THREE.Vector2(x, y);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(group.children || [], true);
    if (!hits?.length) return null;

    const hit = hits.find((h) => h.object?.userData?.building);
    return hit?.object ?? null;
  };

  const selectBuildingMesh = (mesh) => {
    if (!mesh?.userData?.building) {
      clearSelectedBuilding();
      return;
    }

    clearSelectedBuilding();

    selectedBuildingRef.current = {
      mesh,
      originalMaterial: mesh.material,
    };
    highlightSelectedBuilding(mesh);

    const meta = mesh.userData.building;
    const height = Number(meta?.height ?? 0);
    setSelectedBuildingHeight(Number.isFinite(height) ? height : 0);
    setSelectedBuildingUi({
      height: Number.isFinite(height) ? height : 0,
      key: getBuildingKey(meta),
      label: getBuildingLabel(meta),
    });
  };

  const rebuildSelectedBuildingHeight = (nextHeight) => {
    const current = selectedBuildingRef.current;
    const mesh = current?.mesh;
    if (!mesh?.userData?.building) return;

    const meta = mesh.userData.building;
    const shape = meta.shape;
    const baseElevation = Number(meta.baseElevation ?? 0);
    const minHeight = Number(meta.minHeight ?? 0);
    const heightRaw = Number(nextHeight);
    if (!Number.isFinite(heightRaw)) return;

    if (heightRaw <= 0) {
      rebuildBuildingMeshHeight(mesh, 0);
      snapShadesOnBuildingToGround([mesh]);
      return;
    }

    const height = heightRaw;

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, baseElevation + minHeight, 0);
    geometry.computeVertexNormals();

    try {
      mesh.geometry?.dispose?.();
    } catch {
      // ignore
    }
    mesh.geometry = geometry;

    mesh.userData.building = {
      ...meta,
      height,
    };

    try {
      if (meta.feature?.properties) {
        meta.feature.properties.height = String(height);
      }
    } catch {
      // ignore
    }

    snapShadesOnBuildingToRoof([mesh]);
  };

  const getBuildingMeshesByKey = (key) => {
    const group = buildingGroupRef.current;
    if (!group || !key) return [];
    const meshes = [];
    group.traverse((obj) => {
      if (!obj?.isMesh) return;
      const k = obj?.userData?.building?.key;
      if (k === key) meshes.push(obj);
    });
    return meshes;
  };

  const rebuildBuildingHeightByKey = (key, nextHeight) => {
    const meshes = getBuildingMeshesByKey(key);
    meshes.forEach((m) => rebuildBuildingMeshHeight(m, nextHeight));

    const h = Number(nextHeight);
    if (Number.isFinite(h) && h <= 0) {
      snapShadesOnBuildingToGround(meshes);
    } else if (Number.isFinite(h) && h > 0) {
      snapShadesOnBuildingToRoof(meshes);
    }
  };

  const snapShadesOnBuildingToRoof = (buildingMeshes) => {
    if (!buildingMeshes?.length) return;

    const meta = buildingMeshes[0]?.userData?.building;
    const shape = meta?.shape;
    if (!shape) return;

    const height = Number(meta?.height ?? 0);
    if (!Number.isFinite(height) || height <= 0) return;

    const baseElevation = Number(meta?.baseElevation ?? 0);
    const minHeight = Number(meta?.minHeight ?? 0);
    const roofY = baseElevation + minHeight + height;
    if (!Number.isFinite(roofY)) return;

    const points = (() => {
      try {
        const extracted = shape.extractPoints?.(12);
        const outer = extracted?.shape;
        if (Array.isArray(outer) && outer.length >= 3) return outer;
      } catch {
        // ignore
      }
      try {
        const outer = shape.getPoints?.(12);
        if (Array.isArray(outer) && outer.length >= 3) return outer;
      } catch {
        // ignore
      }
      return null;
    })();

    if (!points) return;

    const isInside = (x, z) => {
      try {
        return THREE.ShapeUtils.isPointInPolygon(new THREE.Vector2(x, z), points);
      } catch {
        return false;
      }
    };

    const shades = shadeInstancesRef.current;
    if (!Array.isArray(shades) || shades.length === 0) return;

    shades.forEach((inst) => {
      const x = Number(inst?.position?.x);
      const z = Number(inst?.position?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      if (!isInside(x, z)) return;

      const surfacePt = new THREE.Vector3(x, roofY, z);
      const snapped = applyShadeYOffsetToSurfacePoint(inst.presetId, inst.scale, surfacePt);
      updateShadeInstance(inst.id, { position: { x: snapped.x, y: snapped.y, z: snapped.z } });
    });
  };

  const snapShadesOnBuildingToGround = (buildingMeshes) => {
    if (!buildingMeshes?.length) return;

    const shape = buildingMeshes[0]?.userData?.building?.shape;
    if (!shape) return;

    const points = (() => {
      try {
        const extracted = shape.extractPoints?.(12);
        const outer = extracted?.shape;
        if (Array.isArray(outer) && outer.length >= 3) return outer;
      } catch {
        // ignore
      }
      try {
        const outer = shape.getPoints?.(12);
        if (Array.isArray(outer) && outer.length >= 3) return outer;
      } catch {
        // ignore
      }
      return null;
    })();

    if (!points) return;

    const isInside = (x, z) => {
      try {
        return THREE.ShapeUtils.isPointInPolygon(new THREE.Vector2(x, z), points);
      } catch {
        return false;
      }
    };

    const terrainMesh = terrainStateRef.current?.mesh;
    if (!terrainMesh) return;

    const exaggeration = clampNumber(displayOptions?.exaggeration ?? 1, 0.0001, 1000);
    const raycaster = raycasterRef.current;

    const terrainHeightAtXZ = (x, z) => {
      try {
        const origin = new THREE.Vector3(x, 100000 * exaggeration, z);
        const dir = new THREE.Vector3(0, -1, 0);
        raycaster.set(origin, dir);
        const hits = raycaster.intersectObject(terrainMesh, true);
        const hit = hits?.[0];
        if (!hit?.point) return null;
        return hit.point.y / exaggeration;
      } catch {
        return null;
      }
    };

    const shades = shadeInstancesRef.current;
    if (!Array.isArray(shades) || shades.length === 0) return;

    shades.forEach((inst) => {
      const x = Number(inst?.position?.x);
      const z = Number(inst?.position?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      if (!isInside(x, z)) return;

      const groundY = terrainHeightAtXZ(x, z);
      if (!Number.isFinite(groundY)) return;

      const surfacePt = new THREE.Vector3(x, groundY, z);
      const snapped = applyShadeYOffsetToSurfacePoint(inst.presetId, inst.scale, surfacePt);
      updateShadeInstance(inst.id, { position: { x: snapped.x, y: snapped.y, z: snapped.z } });
    });
  };

  const rebuildBuildingMeshHeight = (mesh, nextHeight) => {
    if (!mesh?.userData?.building) return;
    const meta = mesh.userData.building;
    const shape = meta.shape;
    const baseElevation = Number(meta.baseElevation ?? 0);
    const minHeight = Number(meta.minHeight ?? 0);
    const heightRaw = Number(nextHeight);
    if (!Number.isFinite(heightRaw) || !shape) return;

    if (heightRaw <= 0) {
      mesh.visible = false;
      mesh.userData.building = {
        ...meta,
        height: 0,
      };
      try {
        if (meta.feature?.properties) {
          meta.feature.properties.height = "0";
        }
      } catch {
        // ignore
      }
      return;
    }

    const height = heightRaw;
    mesh.visible = true;

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, baseElevation + minHeight, 0);
    geometry.computeVertexNormals();

    try {
      mesh.geometry?.dispose?.();
    } catch {
      // ignore
    }
    mesh.geometry = geometry;

    mesh.userData.building = {
      ...meta,
      height,
    };

    try {
      if (meta.feature?.properties) {
        meta.feature.properties.height = String(height);
      }
    } catch {
      // ignore
    }
  };

  const markBuildingModified = (mesh, meta, currentHeight) => {
    const key = getBuildingKey(meta);
    if (!key) return;

    const existing = modifiedBuildingsRef.current.get(key);
    if (existing) {
      existing.currentHeight = currentHeight;
    } else {
      const originalHeight = Number(meta?.originalHeight ?? meta?.height ?? 0);
      modifiedBuildingsRef.current.set(key, {
        key,
        label: getBuildingLabel(meta),
        originalHeight: Number.isFinite(originalHeight) ? originalHeight : 0,
        currentHeight,
      });
    }
    syncModifiedBuildingsUi();
  };

  const revertModifiedBuilding = (key) => {
    const entry = modifiedBuildingsRef.current.get(key);
    if (!entry) return;

    rebuildBuildingHeightByKey(key, entry.originalHeight);

    const selected = selectedBuildingRef.current?.mesh;
    if (selected && selected?.userData?.building?.key === key) {
      setSelectedBuildingHeight(entry.originalHeight);
      setSelectedBuildingUi((prev) => (prev ? { ...prev, height: entry.originalHeight } : prev));
    }

    modifiedBuildingsRef.current.delete(key);
    syncModifiedBuildingsUi();
  };

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = window.requestAnimationFrame(tick);
      const mesh = selectedBuildingRef.current?.mesh;
      if (!mesh) return;
      const anchor = getMeshWorldAnchor(mesh);
      const pos = projectWorldToScreen(anchor);
      if (!pos) return;
      setSelectedBuildingMenuPos((prev) => {
        if (!prev) return pos;
        const dx = Math.abs(prev.x - pos.x);
        const dy = Math.abs(prev.y - pos.y);
        if (dx < 0.5 && dy < 0.5) return prev;
        return pos;
      });
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    updateSunAndShadows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadowOverlayEnabled, sunUiDate, sunUiMinutes]);

  function resizeRenderer() {
    const mount = mountRef.current;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!mount || !renderer || !camera) return;

    const w = Math.max(1, mount.clientWidth);
    const h = Math.max(1, mount.clientHeight);

    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, true);
  }

  const ensureDrawGroup = () => {
    const scene = sceneRef.current;
    if (!scene) return null;
    if (drawGroupRef.current) return drawGroupRef.current;

    const drawGroup = new THREE.Group();
    drawGroup.name = "drawings";
    drawGroup.renderOrder = 20;
    drawGroupRef.current = drawGroup;
    scene.add(drawGroup);
    return drawGroup;
  };

  const clearGroup = (group) => {
    if (!group) return;
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose?.();
      }
    });
  };

  const buildLineGeometry = (pts) => {
    const positions = new Array(pts.length * 3);
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      positions[i * 3 + 0] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }
    const geo = new LineGeometry();
    geo.setPositions(positions);
    return geo;
  };

  const syncLineMaterialResolution = (material) => {
    const renderer = rendererRef.current;
    if (!material || !renderer) return;
    const size = new THREE.Vector2();
    renderer.getSize(size);
    if (material.resolution) {
      material.resolution.set(Math.max(1, size.x), Math.max(1, size.y));
    }
  };

  const updateCurrentLine = () => {
    const current = drawStateRef.current.current;
    const drawGroup = ensureDrawGroup();
    if (!drawGroup) return;

    if (currentLineRef.current) {
      drawGroup.remove(currentLineRef.current);
      currentLineRef.current.geometry?.dispose?.();
      currentLineRef.current.material?.dispose?.();
      currentLineRef.current = null;
    }

    if (current.length < 2) return;
    const geo = buildLineGeometry(current);
    const mat = new LineMaterial({
      color: 0x22c55e,
      linewidth: 3.5,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    syncLineMaterialResolution(mat);
    const line = new Line2(geo, mat);
    line.renderOrder = 60;
    line.frustumCulled = false;
    currentLineRef.current = line;
    drawGroup.add(line);
  };

  const updatePreviewLine = (mousePt) => {
    const current = drawStateRef.current.current;
    const drawGroup = ensureDrawGroup();
    if (!drawGroup) return;

    if (previewLineRef.current) {
      drawGroup.remove(previewLineRef.current);
      previewLineRef.current.geometry?.dispose?.();
      previewLineRef.current.material?.dispose?.();
      previewLineRef.current = null;
    }

    if (!mousePt || current.length < 1) return;
    const pts = [...current, mousePt];
    const geo = buildLineGeometry(pts);
    const mat = new LineMaterial({
      color: 0x93c5fd,
      linewidth: 3.0,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
      dashed: true,
      dashScale: 1,
      dashSize: 0.7,
      gapSize: 0.45,
    });
    syncLineMaterialResolution(mat);
    const line = new Line2(geo, mat);
    line.renderOrder = 60;
    line.computeLineDistances();
    line.frustumCulled = false;
    previewLineRef.current = line;
    drawGroup.add(line);
  };

  const screenToPointOnTerrain = (ev) => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!camera || !renderer || !scene) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    const ndc = new THREE.Vector2(x, y);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(ndc, camera);

    const terrainMesh = terrainStateRef.current?.mesh ?? null;
    if (terrainMesh) {
      const hits = raycaster.intersectObject(terrainMesh, true);
      if (hits?.length) {
        const exaggeration = clampNumber(displayOptions?.exaggeration ?? 1, 0.0001, 1000);
        const pt = hits[0].point.clone();
        pt.y = pt.y / exaggeration;
        pt.y += 0.18 / exaggeration;
        return pt;
      }
    }

    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const out = new THREE.Vector3();
    const ok = raycaster.ray.intersectPlane(plane, out);
    if (!ok) return null;
    const exaggeration = clampNumber(displayOptions?.exaggeration ?? 1, 0.0001, 1000);
    out.y += 0.18 / exaggeration;
    return out.clone();
  };

  const createFinalLineFromPoints = (pts) => {
    if (!pts || pts.length < 2) return null;
    const geo = buildLineGeometry(pts);
    const mat = new LineMaterial({
      color: 0x60a5fa,
      linewidth: 3.5,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    syncLineMaterialResolution(mat);
    const line = new Line2(geo, mat);
    line.renderOrder = 60;
    line.frustumCulled = false;
    return line;
  };

  const screenToPointOnBuildingsOrTerrain = (ev) => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!camera || !renderer || !scene) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    const ndc = new THREE.Vector2(x, y);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(ndc, camera);

    const buildingGroup = buildingGroupRef.current;
    if (buildingGroup) {
      const hits = raycaster.intersectObjects(buildingGroup.children || [], true);
      if (hits?.length) {
        const hit = hits.find((h) => {
          const obj = h?.object;
          const b = obj?.userData?.building;
          if (!b) return false;
          const bh = Number(b?.height ?? 0);
          if (!Number.isFinite(bh) || bh <= 0) return false;
          if (obj?.visible === false) return false;
          return true;
        });
        if (hit?.point) {
          const exaggeration = clampNumber(displayOptions?.exaggeration ?? 1, 0.0001, 1000);
          const pt = hit.point.clone();
          pt.y = pt.y / exaggeration;
          pt.y += 0.18 / exaggeration;
          return pt;
        }
      }
    }

    return screenToPointOnTerrain(ev);
  };

  const notifyShadesChanged = () => {
    const cb = onShadesChangedRef.current;
    setShadeUiInstances(shadeInstancesRef.current.map((x) => ({ ...x })));
    if (!cb) return;
    try {
      cb(shadeInstancesRef.current.map((x) => ({ ...x })));
    } catch {
      // ignore
    }
  };

  const getShadeIntersectionsAtEvent = (ev) => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const group = shadeGroupRef.current;
    if (!camera || !renderer || !group) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    const ndc = new THREE.Vector2(x, y);

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(group.children || [], true);
    if (!hits?.length) return null;
    return hits[0];
  };

  const pickShadeInstanceAtEvent = (ev) => {
    const hit = getShadeIntersectionsAtEvent(ev);
    if (!hit) return null;
    let obj = hit.object;
    while (obj && obj !== shadeGroupRef.current) {
      const id = obj?.userData?.shadeInstanceId;
      if (id) return id;
      obj = obj.parent;
    }
    return null;
  };

  const ensurePresetLoaded = async (preset) => {
    if (!preset?.id || !preset?.objUrl) {
      throw new Error("Invalid shade preset");
    }
    const cached = shadePresetCacheRef.current.get(preset.id);
    if (cached) return cached;

    const url = String(preset.objUrl || "");
    const ext = url.split("?")[0].split("#")[0].toLowerCase();

    let group;
    if (ext.endsWith(".obj")) {
      const loader = new OBJLoader();
      group = await loader.loadAsync(url);
    } else if (ext.endsWith(".glb") || ext.endsWith(".gltf")) {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);
      group = gltf?.scene || gltf?.scenes?.[0];
    } else {
      throw new Error(`Unsupported shade model format: ${url}`);
    }

    if (!group) {
      throw new Error(`Failed to load shade model: ${url}`);
    }
    group.updateMatrixWorld(true);

    const vertices = [];
    const faces = [];
    let vOffset = 0;
    group.traverse((obj) => {
      if (!obj?.isMesh) return;
      const geom = obj.geometry;
      const posAttr = geom?.attributes?.position;
      if (!posAttr || !posAttr.array) return;

      const world = obj.matrixWorld;
      const v = new THREE.Vector3();
      for (let i = 0; i < posAttr.count; i += 1) {
        v.fromBufferAttribute(posAttr, i);
        v.applyMatrix4(world);
        vertices.push([v.x, v.y, v.z]);
      }

      const idx = geom.index;
      if (idx && idx.count >= 3) {
        for (let i = 0; i + 2 < idx.count; i += 3) {
          faces.push([vOffset + idx.getX(i), vOffset + idx.getX(i + 1), vOffset + idx.getX(i + 2)]);
        }
      } else {
        for (let i = 0; i + 2 < posAttr.count; i += 3) {
          faces.push([vOffset + i, vOffset + i + 1, vOffset + i + 2]);
        }
      }
      vOffset += posAttr.count;
    });

    if (vertices.length < 3 || faces.length < 1) {
      throw new Error("OBJ produced empty mesh");
    }

    const bbox = new THREE.Box3();
    bbox.setFromArray(vertices.flat());
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const baseMaxDim = Math.max(1e-6, size.x, size.y, size.z);
    const normalizedScale = SHADE_TARGET_MAX_DIM_METERS / baseMaxDim;

    const baseMinY = bbox.min.y;

    const entry = { preset, baseMesh: { vertices, faces }, object3d: group, normalizedScale, baseMinY };
    shadePresetCacheRef.current.set(preset.id, entry);
    return entry;
  };

  const applyShadeYOffsetToSurfacePoint = (presetId, scale, surfacePt) => {
    const entry = shadePresetCacheRef.current.get(presetId);
    if (!entry || !surfacePt) return surfacePt;
    const baseMinY = Number(entry.baseMinY ?? 0) || 0;
    const yLift = (-baseMinY * (Number(scale) || 1)) + SHADE_GROUND_CLEARANCE_METERS;
    return new THREE.Vector3(surfacePt.x, surfacePt.y + yLift, surfacePt.z);
  };

  const addShadeInstance = async (preset, position) => {
    const scene = sceneRef.current;
    if (!scene) return null;

    const group = shadeGroupRef.current;
    if (!group) return null;

    const entry = await ensurePresetLoaded(preset);

    const plannedScale = Number(preset.defaultScale ?? entry.normalizedScale ?? 1) || 1;
    const snappedPos = applyShadeYOffsetToSurfacePoint(preset.id, plannedScale, position);

    const id = `shade_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const inst = {
      id,
      presetId: preset.id,
      position: { x: snappedPos.x, y: snappedPos.y, z: snappedPos.z },
      rotationY: Number(preset.defaultRotationY ?? 0) || 0,
      scale: plannedScale,
      coolingFactor: Number(preset.defaultCoolingFactor ?? 0.1) || 0.1,
    };
    shadeInstancesRef.current = [...shadeInstancesRef.current, inst];

    const obj = entry.object3d.clone(true);
    obj.traverse((child) => {
      child.userData = { ...(child.userData || {}), shadeInstanceId: id };
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    obj.position.set(snappedPos.x, snappedPos.y, snappedPos.z);
    obj.rotation.set(0, THREE.MathUtils.degToRad(inst.rotationY), 0);
    obj.scale.setScalar(inst.scale);
    obj.name = `shade-instance-${id}`;
    obj.userData = { ...(obj.userData || {}), shadeInstanceId: id };
    group.add(obj);
    notifyShadesChanged();
    return inst;
  };

  const updateShadeInstance = (id, patch) => {
    const list = shadeInstancesRef.current;
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return;

    const prev = list[idx];

    let nextPos = prev.position;
    if (patch?.position) {
      nextPos = { ...prev.position, ...patch.position };
    }

    let nextScale = prev.scale;
    if (patch && Object.prototype.hasOwnProperty.call(patch, "scale")) {
      nextScale = Number(patch.scale || 0) || 1;
    }

    if (!patch?.position && patch && Object.prototype.hasOwnProperty.call(patch, "scale") && prev?.presetId) {
      const entry = shadePresetCacheRef.current.get(prev.presetId);
      const baseMinY = Number(entry?.baseMinY ?? 0) || 0;
      const groundY = (prev.position?.y ?? 0) + (baseMinY * (Number(prev.scale) || 1));
      nextPos = { ...(nextPos || prev.position), y: groundY - (baseMinY * nextScale) };
    }

    const next = {
      ...prev,
      ...(patch || {}),
      position: nextPos,
      scale: nextScale,
    };

    const nextList = [...list];
    nextList[idx] = next;
    shadeInstancesRef.current = nextList;

    const group = shadeGroupRef.current;
    if (group) {
      const obj = group.getObjectByName(`shade-instance-${id}`);
      if (obj) {
        obj.position.set(next.position.x, next.position.y, next.position.z);
        obj.rotation.set(0, THREE.MathUtils.degToRad(next.rotationY || 0), 0);
        obj.scale.setScalar(next.scale || 1);
      }
    }

    if (selectedShadeRef.current === id) {
      setSelectedShadeUi({ ...next });
      if (patch && Object.prototype.hasOwnProperty.call(patch, "scale")) {
        setShadeScaleDraft(String(nextScale));
      }
    }

    notifyShadesChanged();
  };

  const removeShadeInstance = (id) => {
    const group = shadeGroupRef.current;
    if (group) {
      const obj = group.getObjectByName(`shade-instance-${id}`);
      if (obj) {
        group.remove(obj);
        try {
          obj.traverse((child) => {
            child.geometry?.dispose?.();
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => m?.dispose?.());
            } else {
              child.material?.dispose?.();
            }
          });
        } catch {
          // ignore
        }
      }
    }

    shadeInstancesRef.current = shadeInstancesRef.current.filter((x) => x.id !== id);
    if (selectedShadeRef.current === id) {
      clearSelectedShade();
    }
    notifyShadesChanged();
  };

  const clearShadeInstances = () => {
    const group = shadeGroupRef.current;
    if (group) {
      const children = [...(group.children || [])];
      children.forEach((c) => {
        group.remove(c);
        try {
          c.traverse((child) => {
            child.geometry?.dispose?.();
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => m?.dispose?.());
            } else {
              child.material?.dispose?.();
            }
          });
        } catch {
          // ignore
        }
      });
    }
    shadeInstancesRef.current = [];
    selectedShadeRef.current = null;
    notifyShadesChanged();
  };

  const getShadeMeshesForAnalysis = () => {
    const out = [];
    for (const inst of shadeInstancesRef.current) {
      const entry = shadePresetCacheRef.current.get(inst.presetId);
      if (!entry?.baseMesh) continue;
      const base = entry.baseMesh;

      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3(inst.position.x, inst.position.y, inst.position.z);
      const rot = new THREE.Euler(0, THREE.MathUtils.degToRad(inst.rotationY || 0), 0, "XYZ");
      const scl = new THREE.Vector3(1, 1, 1).multiplyScalar(inst.scale || 1);
      m.compose(pos, new THREE.Quaternion().setFromEuler(rot), scl);

      const vertices = (base.vertices || []).map((v) => {
        const p = new THREE.Vector3(Number(v?.[0] ?? 0), Number(v?.[1] ?? 0), Number(v?.[2] ?? 0));
        p.applyMatrix4(m);
        return [p.x, p.y, p.z];
      });

      out.push({
        vertices,
        faces: base.faces || [],
        cooling_factor: clampNumber(inst.coolingFactor ?? 0, 0, 1),
      });
    }
    return out;
  };

  function clearAnalysis() {
    const scene = sceneRef.current;
    const overlay = analysisOverlayRef.current;
    if (!scene || !overlay) return;

    scene.remove(overlay);
    disposeSunHoursOverlay(overlay);
    analysisOverlayRef.current = null;
    setAnalysisLegend(null);
  }

  function disposeTerrainAndLayers() {
    const scene = sceneRef.current;
    if (!scene) return;

    clearAnalysis();
    clearMeshOverlay();

    if (roadGroupRef.current) {
      scene.remove(roadGroupRef.current);
      disposeRoadGroup(roadGroupRef.current);
      roadGroupRef.current = null;
    }

    if (buildingGroupRef.current) {
      scene.remove(buildingGroupRef.current);
      disposeBuildingGroup(buildingGroupRef.current);
      buildingGroupRef.current = null;
    }

    const terrainState = terrainStateRef.current;
    if (terrainState) {
      scene.remove(terrainState.mesh);
      terrainState.geometry?.dispose?.();
      terrainState.material?.map?.dispose?.();
      terrainState.material?.dispose?.();
      terrainStateRef.current = null;
    }

    if (drawGroupRef.current) {
      clearGroup(drawGroupRef.current);
      drawGroupRef.current.clear();
    }

    drawStateRef.current = { polylines: [], current: [] };
    currentLineRef.current = null;
    previewLineRef.current = null;
    setDrawStatus("");

    geoRefRef.current = null;
  }

  function frameScene() {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const items = [];
    if (terrainStateRef.current?.mesh) items.push(terrainStateRef.current.mesh);
    if (buildingGroupRef.current) items.push(buildingGroupRef.current);
    if (roadGroupRef.current) items.push(roadGroupRef.current);
    if (!items.length) return;

    const box = new THREE.Box3();
    items.forEach((obj) => box.expandByObject(obj));
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = (camera.fov * Math.PI) / 180;
    const fitHeightDistance = maxDim / (2 * Math.tan(fov / 2));
    const fitWidthDistance = fitHeightDistance / camera.aspect;
    const distance = 1.35 * Math.max(fitHeightDistance, fitWidthDistance);

    const direction = new THREE.Vector3(1, 0.85, 1).normalize();
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(0.1, distance / 2000);
    camera.far = Math.max(10000, distance * 10);
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
  }

  async function withRetries(task, { retries = 2, baseDelayMs = 600, maxDelayMs = 4000 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await task();
      } catch (e) {
        lastError = e;
        if (attempt >= retries) break;
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  async function generate({ includeOsmLayers }) {
    const scene = sceneRef.current;
    if (!scene) return;

    const myGenerationId = (generationIdRef.current += 1);

    const currentBounds = boundsRef.current;

    const isCancelled = () => myGenerationId !== generationIdRef.current;

    try {
      setIsGenerating(true);
      reportStatus("Requesting DEM...");

      clearShadeInstances();
      disposeTerrainAndLayers();

      const result = await fetchDemWithFallback(currentBounds, apiKey, reportStatus);

      if (isCancelled()) return;

      reportStatus("Parsing GeoTIFF...");
      const parsed = await parseGeoTiff(result.arrayBuffer);

      if (isCancelled()) return;

      const geoReference = createGeoReference(currentBounds, parsed.width, parsed.height);
      geoRefRef.current = geoReference;

      const meshResult = createTerrainMesh(parsed, geoReference.terrainWidth, geoReference.terrainDepth);

      if (isCancelled()) {
        try {
          meshResult?.geometry?.dispose?.();
          meshResult?.material?.map?.dispose?.();
          meshResult?.material?.dispose?.();
        } catch {
          // ignore
        }
        return;
      }

      const terrainState = {
        ...meshResult,
        parsedTerrain: parsed,
        raster: parsed.raster,
        width: parsed.width,
        height: parsed.height,
        terrainWidth: geoReference.terrainWidth,
        terrainDepth: geoReference.terrainDepth,
        minElevation: parsed.minElevation,
        maxElevation: parsed.maxElevation,
      };

      terrainStateRef.current = terrainState;

      updateTerrainMaterial(terrainState, {
        colorMode: displayOptions.colorMode,
        hillshadeEnabled: displayOptions.hillshadeEnabled,
        exaggeration: displayOptions.exaggeration,
        wireframe: displayOptions.wireframe,
      });

      applyVerticalExaggeration(terrainState, displayOptions.exaggeration);
      terrainState.mesh.visible = !!displayOptions.showTerrain;
      terrainState.mesh.receiveShadow = true;
      terrainState.mesh.castShadow = false;

      scene.add(terrainState.mesh);
      frameScene();

      if (includeOsmLayers) {
        reportStatus("Fetching OSM buildings & roads...");

        const [buildingsResult, roadsResult] = await Promise.allSettled([
          withRetries(() => fetchBuildingsGeoJson(currentBounds, reportStatus), { retries: 2 }),
          withRetries(() => fetchRoadGeoJson(currentBounds, reportStatus), { retries: 2 }),
        ]);

        if (isCancelled()) {
          return;
        }

        let loadedAny = false;
        const failed = [];

        if (buildingsResult.status === "fulfilled") {
          const buildingFeatures = buildingsResult.value;
          buildingFeaturesRef.current = buildingFeatures;
          const bGroup = createBuildingGroup(buildingFeatures, parsed, geoReference, buildingOptions);
          buildingGroupRef.current = bGroup;
          bGroup.traverse((obj) => {
            if (obj?.isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
            }
          });
          scene.add(bGroup);
          loadedAny = true;
        } else {
          failed.push(`buildings: ${String(buildingsResult.reason?.message || buildingsResult.reason)}`);
          buildingFeaturesRef.current = [];
        }

        if (roadsResult.status === "fulfilled") {
          const roadFeatures = roadsResult.value;
          const rGroup = createRoadGroup(roadFeatures, parsed, geoReference, roadOptions);
          roadGroupRef.current = rGroup;
          scene.add(rGroup);
          loadedAny = true;
        } else {
          failed.push(`roads: ${String(roadsResult.reason?.message || roadsResult.reason)}`);
        }

        if (loadedAny) {
          frameScene();
        }

        if (failed.length) {
          reportStatus(`OSM layers failed: ${failed.join(", ")}`);
        } else if (loadedAny) {
          reportStatus("OSM layers loaded.");
        } else {
          reportStatus("OSM layers skipped.");
        }
      }
    } catch (e) {
      reportStatus(`Generate failed: ${String(e?.message || e)}`);
    } finally {
      if (!isCancelled()) {
        setIsGenerating(false);
      }
    }
  }

  generateRef.current = generate;

  useImperativeHandle(
    ref,
    () => ({
      setOptions(nextOptions) {
        if (!nextOptions || typeof nextOptions !== "object") return;
        setLocalOptions(nextOptions);
      },
      setBounds(nextBounds, { fit } = {}) {
        if (!nextBounds) return;
        const normalized = { ...nextBounds };
        boundsRef.current = normalized;
        setBounds(normalized);
        if (fit) {
          // framing is based on terrain; if no terrain yet, nothing to do.
        }
      },
      getBounds() {
        return boundsRef.current;
      },
      async generateTerrain() {
        await generate({ includeOsmLayers: false });
      },
      async generateTerrainAndOsm() {
        await generate({ includeOsmLayers: true });
      },
      frame() {
        frameScene();
      },
      clearSolar() {
        clearAnalysis();
      },
      async runSolarAnalysis(settings, { epwStationId, shadeMeshes } = {}) {
        const terrainState = terrainStateRef.current;
        const geoReference = geoRefRef.current;
        const buildingFeatures = buildingFeaturesRef.current || [];

        if (!terrainState || !geoReference) {
          throw new Error("Generate terrain (and buildings) before running solar analysis.");
        }

        const result = await runDirectSunHoursAnalysis({
          bounds: boundsRef.current,
          terrainState,
          buildingFeatures,
          geoReference,
          buildingOptions,
          settings,
          epwStationId,
          shadeMeshes,
        });

        const scene = sceneRef.current;
        if (scene) {
          clearAnalysis();
          const overlay = createSunHoursOverlay(result, displayOptions.exaggeration);
          analysisOverlayRef.current = overlay;
          scene.add(overlay);
          setAnalysisLegend({ min: Number(result?.min ?? 0), max: Number(result?.max ?? 0) });
        }

        return result;
      },
      setSolarOverlay(result) {
        const scene = sceneRef.current;
        const terrainState = terrainStateRef.current;
        if (!scene || !terrainState || !result) return;
        clearAnalysis();
        const overlay = createSunHoursOverlay(result, displayOptions.exaggeration);
        analysisOverlayRef.current = overlay;
        scene.add(overlay);
        setAnalysisLegend({ min: Number(result?.min ?? 0), max: Number(result?.max ?? 0) });
      },
      showSunPath(settings) {
        showSunPath(settings);
      },
      clearSunPath() {
        clearSunPath();
      },

      setOnShadesChanged(cb) {
        onShadesChangedRef.current = typeof cb === "function" ? cb : null;
        notifyShadesChanged();
      },
      async addShadeFromPreset(preset, position) {
        return addShadeInstance(preset, position);
      },
      updateShadeInstance(id, patch) {
        updateShadeInstance(id, patch);
      },
      removeShadeInstance(id) {
        removeShadeInstance(id);
      },
      clearShadeInstances() {
        clearShadeInstances();
      },
      getShadeInstances() {
        return shadeInstancesRef.current.map((x) => ({ ...x }));
      },
      getShadeMeshesForAnalysis() {
        return getShadeMeshesForAnalysis();
      },
    }),
    [displayOptions]
  );

  // init three
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    setWebglInitError(null);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0a121e");

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500000);
    camera.position.set(500, 350, 500);

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      setWebglInitError(e instanceof Error ? e.message : String(e));
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dollySpeed = 0.85;
    if ("zoomToCursor" in controls) {
      controls.zoomToCursor = true;
    }
    controls.target.set(0, 10, 0);

    const ambientLight = new THREE.AmbientLight("#ffffff", 1.05);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight("#fff6db", 2.0);
    directionalLight.position.set(80, 120, 60);
    directionalLight.castShadow = false;
    directionalLight.shadow.camera = new THREE.OrthographicCamera(-200, 200, 200, -200, 0.1, 5000);
    directionalLight.shadow.mapSize.set(2048, 2048);
    directionalLight.shadow.bias = -0.00015;
    directionalLight.shadow.normalBias = 0.02;
    const lightTarget = new THREE.Object3D();
    lightTarget.position.set(0, 0, 0);
    scene.add(lightTarget);
    directionalLight.target = lightTarget;
    scene.add(directionalLight);

    const shadeGroup = new THREE.Group();
    shadeGroup.name = "shade-instances";
    shadeGroup.renderOrder = 34;
    shadeGroupRef.current = shadeGroup;
    scene.add(shadeGroup);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;
    ambientLightRef.current = ambientLight;
    sunLightRef.current = directionalLight;
    sunTargetRef.current = lightTarget;

    const drawGroup = new THREE.Group();
    drawGroup.name = "drawings";
    drawGroup.renderOrder = 20;
    drawGroupRef.current = drawGroup;
    scene.add(drawGroup);

    let raf = 0;
    const animate = () => {
      raf = window.requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => resizeRenderer();
    window.addEventListener("resize", onResize);

    let resizeObserver = null;
    try {
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => resizeRenderer());
        resizeObserver.observe(mount);
      }
    } catch {
      resizeObserver = null;
    }

    resizeRenderer();

    updateSunAndShadows();

    return () => {
      window.removeEventListener("resize", onResize);
      try {
        resizeObserver?.disconnect?.();
      } catch {
        // ignore
      }
      window.cancelAnimationFrame(raf);

      disposeTerrainAndLayers();

      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);

      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (drawMode) {
      controls.enableRotate = false;
      controls.enablePan = false;
      controls.enableZoom = true;
    } else {
      controls.enableRotate = true;
      controls.enablePan = true;
      controls.enableZoom = true;
    }
  }, [drawMode]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = renderer?.domElement;
    if (!canvas) return;

    const handleDragOver = (ev) => {
      ev.preventDefault();
    };

    const handleDrop = async (ev) => {
      ev.preventDefault();
      if (drawModeRef.current) return;
      const presetId = ev.dataTransfer?.getData?.("text/shade-preset") || ev.dataTransfer?.getData?.("text/plain");
      if (!presetId) return;
      const pt = screenToPointOnBuildingsOrTerrain(ev);
      if (!pt) return;
      const preset = shadePresetsRef.current.get(presetId);
      if (!preset) return;
      try {
        await addShadeInstance(preset, pt);
      } catch {
        // ignore
      }
    };

    const handleMouseDown = (ev) => {
      if (ev.button !== 0) return;

      if (!drawModeRef.current) {
        const id = pickShadeInstanceAtEvent(ev);
        if (!id) return;
        ev.preventDefault();
        selectedShadeRef.current = id;
        const inst = shadeInstancesRef.current.find((x) => x.id === id) || null;
        setSelectedShadeUi(inst ? { ...inst } : null);
        const mount = mountRef.current;
        const rect = mount?.getBoundingClientRect?.();
        if (rect) {
          setSelectedShadeMenuPos({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
        } else {
          setSelectedShadeMenuPos({ x: ev.clientX, y: ev.clientY });
        }
        return;
      }

      ev.preventDefault();
      const pt = screenToPointOnTerrain(ev);
      if (!pt) {
        setDrawStatus("Draw: no intersection");
        return;
      }
      drawStateRef.current.current.push(pt);
      setDrawStatus(`Draw: ${drawStateRef.current.current.length} pts`);
      updateCurrentLine();
      updatePreviewLine(pt);
      forceDrawUiUpdate((x) => x + 1);
    };

    const handleMouseMove = (ev) => {
      if (!drawModeRef.current) {
        if (!carryShadeRef.current?.id) return;
        const pt = screenToPointOnBuildingsOrTerrain(ev);
        if (!pt) return;
        const movingId = carryShadeRef.current.id;
        const movingInst = shadeInstancesRef.current.find((x) => x.id === movingId);
        const nextPt = movingInst
          ? applyShadeYOffsetToSurfacePoint(movingInst.presetId, movingInst.scale, pt)
          : pt;
        updateShadeInstance(movingId, { position: { x: nextPt.x, y: nextPt.y, z: nextPt.z } });
        return;
      }
      const pt = screenToPointOnTerrain(ev);
      updatePreviewLine(pt);
    };

    const handleKeyDown = (ev) => {
      if (ev.key === "Escape") {
        if (carryShadeRef.current?.id || selectedShadeMenuPos) {
          clearSelectedShade();
          return;
        }
      }
      if (ev.key !== "Delete") return;
      const id = selectedShadeRef.current;
      if (!id) return;
      removeShadeInstance(id);
    };

    const handleDoubleClick = (ev) => {
      if (drawModeRef.current) {
        return;
      }

      if (carryShadeRef.current?.id) {
        const pt = screenToPointOnBuildingsOrTerrain(ev);
        if (!pt) return;
        const movingId = carryShadeRef.current.id;
        const movingInst = shadeInstancesRef.current.find((x) => x.id === movingId);
        const nextPt = movingInst
          ? applyShadeYOffsetToSurfacePoint(movingInst.presetId, movingInst.scale, pt)
          : pt;
        updateShadeInstance(movingId, { position: { x: nextPt.x, y: nextPt.y, z: nextPt.z } });
        carryShadeRef.current = null;
        return;
      }

      const shadeId = pickShadeInstanceAtEvent(ev);
      if (shadeId) {
        selectedShadeRef.current = shadeId;
        carryShadeRef.current = { id: shadeId };
        ev.preventDefault();
        return;
      }

      const mesh = pickBuildingAtEvent(ev);
      if (!mesh) {
        clearSelectedBuilding();
        return;
      }
      selectBuildingMesh(mesh);
    };

    canvas.addEventListener("dragover", handleDragOver);
    canvas.addEventListener("drop", handleDrop);
    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("keydown", handleKeyDown);
    canvas.addEventListener("dblclick", handleDoubleClick);
    return () => {
      canvas.removeEventListener("dragover", handleDragOver);
      canvas.removeEventListener("drop", handleDrop);
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("keydown", handleKeyDown);
      canvas.removeEventListener("dblclick", handleDoubleClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishCurrentPolyline = () => {
    const current = drawStateRef.current.current;
    if (current.length < 2) return;

    drawStateRef.current.polylines.push(current.map((p) => p.clone()));
    drawStateRef.current.current = [];

    const drawGroup = ensureDrawGroup();
    if (drawGroup) {
      if (currentLineRef.current) {
        drawGroup.remove(currentLineRef.current);
        currentLineRef.current.geometry?.dispose?.();
        currentLineRef.current.material?.dispose?.();
        currentLineRef.current = null;
      }

      const lastPts = drawStateRef.current.polylines[drawStateRef.current.polylines.length - 1];
      const finalLine = createFinalLineFromPoints(lastPts);
      if (finalLine) {
        drawGroup.add(finalLine);
      }
    }

    if (previewLineRef.current && drawGroupRef.current) {
      drawGroupRef.current.remove(previewLineRef.current);
      previewLineRef.current.geometry?.dispose?.();
      previewLineRef.current.material?.dispose?.();
      previewLineRef.current = null;
    }

    setDrawStatus("Draw: polyline saved");
    forceDrawUiUpdate((x) => x + 1);
  };

  const undoDraw = () => {
    const current = drawStateRef.current.current;
    if (current.length > 0) {
      current.pop();
      updateCurrentLine();
      forceDrawUiUpdate((x) => x + 1);
      return;
    }

    const lines = drawStateRef.current.polylines;
    if (!lines.length || !drawGroupRef.current) return;

    const last = drawGroupRef.current.children
      .slice()
      .reverse()
      .find((c) => c && (c.isLine2 || c.type === "Line") && c.userData?.isFinal);
    if (last) {
      drawGroupRef.current.remove(last);
      last.geometry?.dispose?.();
      last.material?.dispose?.();
    }
    lines.pop();
    forceDrawUiUpdate((x) => x + 1);
  };

  const clearAllDrawings = () => {
    drawStateRef.current.polylines = [];
    drawStateRef.current.current = [];
    if (drawGroupRef.current) {
      clearGroup(drawGroupRef.current);
      drawGroupRef.current.clear();
    }
    currentLineRef.current = null;
    previewLineRef.current = null;
    setDrawStatus("");
    forceDrawUiUpdate((x) => x + 1);
  };

  const runDrawnPolylines = async () => {
    const scene = sceneRef.current;
    if (!scene) return;

    const polylines = (drawStateRef.current?.polylines || []).map((line) =>
      (line || []).map((p) => [p.x, p.y, p.z])
    );

    if (!polylines.length) {
      setDrawStatus("Run: no finished polylines (click Finish first)");
      return;
    }

    setDrawStatus("Run: generating mesh...");

    try {
      const result = await runMeshFromPolylines({
        polylines,
        options: {
          y: 0,
          offset: 0,
          relax_iterations: 0,
          relax_strength: 0.35,
          edge_length_factor: 1.0,
        },
      });

      const mesh = result?.mesh;
      const vertices = mesh?.vertices;
      const faces = mesh?.faces;

      if (!Array.isArray(vertices) || !Array.isArray(faces) || vertices.length < 3 || faces.length < 1) {
        throw new Error("Mesh backend returned empty mesh");
      }

      applyMeshOverlay(mesh);
      setDrawStatus(`Run: mesh ok (V=${vertices.length}, F=${faces.length})`);
    } catch (e) {
      setDrawStatus(`Run error: ${String(e?.message || e)}`);
    }
  };

  // apply display options changes
  useEffect(() => {
    const terrainState = terrainStateRef.current;
    if (terrainState) {
      terrainState.mesh.visible = !!displayOptions.showTerrain;
      updateTerrainMaterial(terrainState, {
        colorMode: displayOptions.colorMode,
        hillshadeEnabled: displayOptions.hillshadeEnabled,
        exaggeration: displayOptions.exaggeration,
        wireframe: displayOptions.wireframe,
      });
      applyVerticalExaggeration(terrainState, displayOptions.exaggeration);
    }

    if (buildingGroupRef.current) {
      updateBuildingDisplay(buildingGroupRef.current, buildingOptions);
    }

    if (roadGroupRef.current) {
      updateRoadDisplay(roadGroupRef.current, roadOptions);
    }

    if (analysisOverlayRef.current) {
      updateSunHoursOverlay(analysisOverlayRef.current, displayOptions.exaggeration);
    }

    if (meshOverlayRef.current) {
      meshOverlayRef.current.scale.y = displayOptions.exaggeration;
    }

    if (drawGroupRef.current) {
      drawGroupRef.current.scale.y = displayOptions.exaggeration;
    }

    updateSunAndShadows();
  }, [displayOptions, buildingOptions, roadOptions]);

  // mesh panel integration (replaces Grasshopper)
  useEffect(() => {
    const onReq = (ev) => {
      const detail = ev?.detail || {};
      const requestId = detail.requestId;

      const polylines = (drawStateRef.current?.polylines || [])
        .map((line) => (line || []).map((p) => [p.x, p.y, p.z]));

      try {
        window.dispatchEvent(
          new CustomEvent("mesh:polylines-response", {
            detail: { requestId, polylines },
          })
        );
      } catch {
        // ignore
      }
    };

    const onApply = (ev) => {
      const detail = ev?.detail || {};
      if (!detail.mesh) return;
      try {
        applyMeshOverlay(detail.mesh);
      } catch {
        // ignore
      }
    };

    const onClear = () => {
      try {
        clearMeshOverlay();
      } catch {
        // ignore
      }
    };

    window.addEventListener("mesh:request-polylines", onReq);
    window.addEventListener("mesh:apply", onApply);
    window.addEventListener("mesh:clear", onClear);
    return () => {
      window.removeEventListener("mesh:request-polylines", onReq);
      window.removeEventListener("mesh:apply", onApply);
      window.removeEventListener("mesh:clear", onClear);
    };
  }, [displayOptions.exaggeration]);

  // listen for Analyze events and auto-generate terrain+OSM
  useEffect(() => {
    const handler = (event) => {
      const data = event?.data;
      if (!data) return;
      if (data.type !== "cadmapper:analyze") return;
      const next = boundsFromAnalyze(data.bbox);
      if (!next) return;
      // IMPORTANT: generate() reads boundsRef.current, not React state.
      // setBounds(next) is async, so without this assignment we can generate the DEFAULT bounds.
      boundsRef.current = next;
      setBounds(next);
      try {
        setIsGenerating(true);
      } catch {
        // ignore
      }
      reportStatus("Loading city model...");
      // wait a tick so boundsRef updates
      window.setTimeout(() => {
        try {
          generateRef.current?.({ includeOsmLayers: true });
        } catch {
          try {
            setIsGenerating(false);
          } catch {
            // ignore
          }
        }
      }, 0);
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentPts = drawStateRef.current.current.length;
  const totalFinal = drawStateRef.current.polylines.length;

  // force re-render when presets are loaded
  void shadePresetsUiNonce;
  const shadePresets = Array.from(shadePresetsRef.current.values());
  void presetThumbNonce;

  const getPresetThumbUrl = (preset) => {
    const label = String(preset?.label || "");
    if (!label) return null;
    const svgName = label.replace(/\.[^/.]+$/, ".svg");
    const baseUrl = import.meta.env.BASE_URL || "/";
    return `${baseUrl}3dmodels/${encodeURIComponent(svgName)}`;
  };

  const presetPreviewUrl = (preset) => getPresetThumbUrl(preset);

  const analysisLegendGradient = useMemo(() => {
    if (!analysisLegend) return null;
    const stops = [];
    for (let i = 0; i <= 10; i += 1) {
      const t = i / 10;
      const c = sampleAnalysisColor(t);
      stops.push(`rgb(${c.r}, ${c.g}, ${c.b}) ${(t * 100).toFixed(1)}%`);
    }
    return `linear-gradient(to top, ${stops.join(", ")})`;
  }, [analysisLegend]);

  return (
    <div
      ref={mountRef}
      style={{ position: "relative", width: "100%", height: "100%", background: "#0a121e", overflow: "hidden" }}
    >
      {isGenerating && !webglInitError && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(10, 18, 30, 0.35)",
            zIndex: 9,
            pointerEvents: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              padding: 14,
              borderRadius: 12,
              background: "rgba(10, 18, 30, 0.75)",
              color: "rgba(230,240,255,0.95)",
              minWidth: 240,
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: "50%",
                border: "4px solid rgba(255,255,255,0.22)",
                borderTopColor: "rgba(96,165,250,0.95)",
                animation: "shadela-spin 0.9s linear infinite",
              }}
            />
            <div style={{ fontSize: 12, opacity: 0.95 }}>
              {generateStatusText || "Loading city model..."}
            </div>
          </div>
        </div>
      )}
      {webglInitError && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            textAlign: "center",
            color: "rgba(230,240,255,0.95)",
            background: "rgba(10, 18, 30, 0.75)",
            zIndex: 10,
          }}
        >
          WebGL renderer failed to initialize: {webglInitError}
        </div>
      )}
      <style>{"@keyframes shadela-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}"}</style>
      <div
        ref={toolbarRef}
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          padding: "10px 12px",
          borderRadius: 10,
          background: "rgba(10, 18, 30, 0.65)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "rgba(230,240,255,0.95)",
          backdropFilter: "blur(6px)",
          zIndex: 5,
          pointerEvents: "auto",
          userSelect: "none",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={() => setShadowOverlayEnabled((v) => !v)}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: shadowOverlayEnabled ? "rgba(250,204,21,0.88)" : "rgba(17,24,39,0.8)",
            color: shadowOverlayEnabled ? "#0b1220" : "#e5e7eb",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {shadowOverlayEnabled ? "Shadows: ON" : "Shadows: OFF"}
        </button>

        <button
          type="button"
          onClick={runDrawnPolylines}
          disabled={totalFinal < 1}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(168,85,247,0.85)",
            color: "#e5e7eb",
            cursor: totalFinal >= 1 ? "pointer" : "not-allowed",
            opacity: totalFinal >= 1 ? 1 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          Run
        </button>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            whiteSpace: "nowrap",
            opacity: shadowOverlayEnabled ? 1 : 0.45,
          }}
        >
          date
          <input
            type="date"
            value={sunUiDate}
            onChange={(e) => setSunUiDate(e.target.value)}
            disabled={!shadowOverlayEnabled}
            style={{
              padding: "5px 8px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(0,0,0,0.22)",
              color: "#e5e7eb",
              outline: "none",
            }}
          />
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            whiteSpace: "nowrap",
            opacity: shadowOverlayEnabled ? 1 : 0.45,
          }}
        >
          time
          <input
            type="range"
            min={0}
            max={1439}
            step={1}
            value={sunUiMinutes}
            onChange={(e) => setSunUiMinutes(Number(e.target.value))}
            disabled={!shadowOverlayEnabled}
            style={{ width: 160 }}
          />
          <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.9 }}>
            {String(Math.floor(clampNumber(sunUiMinutes, 0, 1439) / 60)).padStart(2, "0")}:
            {String(Math.floor(clampNumber(sunUiMinutes, 0, 1439) % 60)).padStart(2, "0")}
          </span>
        </label>

        <button
          type="button"
          onClick={() => {
            const next = !drawModeRef.current;
            drawModeRef.current = next;
            setDrawMode(next);
            if (next) {
              try {
                clearAllDrawings();
              } catch {
                // ignore
              }
              try {
                clearMeshOverlay();
              } catch {
                // ignore
              }
            }
            setDrawStatus(next ? "Draw: click to add points" : "");
          }}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: drawMode ? "rgba(34,197,94,0.85)" : "rgba(17,24,39,0.8)",
            color: "#e5e7eb",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {drawMode ? "Draw: ON" : "Draw: OFF"}
        </button>

        <button
          type="button"
          onClick={finishCurrentPolyline}
          disabled={currentPts < 2}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(59,130,246,0.85)",
            color: "#e5e7eb",
            cursor: currentPts >= 2 ? "pointer" : "not-allowed",
            opacity: currentPts >= 2 ? 1 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          Finish
        </button>

        <button
          type="button"
          onClick={undoDraw}
          disabled={currentPts === 0 && totalFinal === 0}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(17,24,39,0.8)",
            color: "#e5e7eb",
            cursor: currentPts > 0 || totalFinal > 0 ? "pointer" : "not-allowed",
            opacity: currentPts > 0 || totalFinal > 0 ? 1 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          Undo
        </button>

        <button
          type="button"
          onClick={clearAllDrawings}
          disabled={currentPts === 0 && totalFinal === 0}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(239,68,68,0.85)",
            color: "#e5e7eb",
            cursor: currentPts > 0 || totalFinal > 0 ? "pointer" : "not-allowed",
            opacity: currentPts > 0 || totalFinal > 0 ? 1 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          Clear
        </button>

        <div style={{ fontSize: 12, opacity: 0.85, whiteSpace: "nowrap" }}>lines: {totalFinal} | points: {currentPts}</div>
        {drawStatus ? (
          <div style={{ fontSize: 12, opacity: 0.9, flexBasis: "100%" }}>{drawStatus}</div>
        ) : null}
      </div>

      <div
        style={{
          position: "absolute",
          top: toolbarBottomPx,
          left: 10,
          width: 320,
          maxWidth: "calc(100% - 20px)",
          display: "grid",
          gap: 10,
          padding: "10px 12px",
          borderRadius: 12,
          background: "rgba(10, 18, 30, 0.65)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "rgba(230,240,255,0.95)",
          backdropFilter: "blur(6px)",
          zIndex: 5,
          pointerEvents: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 750, opacity: 0.95 }}>Shades</div>
          <button
            type="button"
            onClick={() => clearShadeInstances()}
            disabled={!shadeUiInstances.length}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(239,68,68,0.85)",
              color: "#e5e7eb",
              cursor: shadeUiInstances.length ? "pointer" : "not-allowed",
              opacity: shadeUiInstances.length ? 1 : 0.5,
              whiteSpace: "nowrap",
            }}
          >
            Clear
          </button>
        </div>

        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Drag preset onto the city. Double-click a shade to carry, double-click again to place. Delete key removes selected.
        </div>

        {shadePresetsLoadError ? (
          <div style={{ fontSize: 12, opacity: 0.9, color: "rgba(248,113,113,0.95)" }}>
            Failed to load presets: {shadePresetsLoadError}
          </div>
        ) : null}

        <details
          style={{
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(2,6,23,0.22)",
            padding: "6px 8px",
          }}
        >
          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700, opacity: 0.95, userSelect: "none" }}>
            presets ({shadePresets.length})
          </summary>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
            {shadePresets.map((p) => (
              <div
                key={p.id}
                draggable
                onDragStart={(e) => {
                  try {
                    e.dataTransfer.setData("text/shade-preset", p.id);
                    e.dataTransfer.setData("text/plain", p.id);
                    e.dataTransfer.effectAllowed = "copy";
                  } catch {
                    // ignore
                  }
                }}
                style={{
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(17,24,39,0.65)",
                  cursor: "grab",
                }}
                title="Drag onto the city"
              >
                {!presetThumbErrorRef.current.has(p.id) && presetPreviewUrl(p) ? (
                  <img
                    src={presetPreviewUrl(p)}
                    alt={p.label}
                    draggable={false}
                    onError={() => {
                      presetThumbErrorRef.current.add(p.id);
                      setPresetThumbNonce((n) => n + 1);
                    }}
                    style={{
                      display: "block",
                      width: 92,
                      height: 56,
                      objectFit: "contain",
                      marginBottom: 6,
                      filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.35))",
                    }}
                  />
                ) : (
                  <div style={{ fontSize: 12, fontWeight: 650, whiteSpace: "nowrap" }}>{p.label}</div>
                )}
                <div style={{ fontSize: 11, opacity: 0.8 }}>shade: {Math.round((p.defaultCoolingFactor || 0) * 100)}%</div>
              </div>
            ))}
          </div>
        </details>

        {!shadePresetsLoadError && shadePresets.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            No presets found. Add filenames to <code>/3dmodels/manifest.json</code>.
          </div>
        ) : null}

        <div style={{ fontSize: 12, opacity: 0.82 }}>placed: {shadeUiInstances.length}</div>
      </div>

      {analysisLegend && analysisLegendGradient ? (
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            zIndex: 5,
            display: "flex",
            flexDirection: "row",
            alignItems: "stretch",
            gap: 10,
            padding: "10px 10px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(10, 18, 30, 0.65)",
            color: "rgba(230,240,255,0.95)",
            backdropFilter: "blur(6px)",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              width: 16,
              height: 180,
              borderRadius: 10,
              background: analysisLegendGradient,
              border: "1px solid rgba(255,255,255,0.18)",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: 180 }}>
            <div style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{analysisLegend.max.toFixed(2)}</div>
            <div style={{ fontSize: 11, opacity: 0.8, textAlign: "left" }}>solar</div>
            <div style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{analysisLegend.min.toFixed(2)}</div>
          </div>
        </div>
      ) : null}

      {selectedShadeUi ? (
        <div
          ref={shadeMenuRef}
          style={{
            position: "absolute",
            left: selectedShadeMenuPos?.x ?? 10,
            top: selectedShadeMenuPos?.y ?? 10,
            transform: "translate(-50%, calc(-100% - 14px))",
            zIndex: 6,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255, 255, 255, 0.18)",
            background: "rgba(10, 18, 30, 0.72)",
            color: "rgba(255, 255, 255, 0.95)",
            minWidth: 240,
            pointerEvents: "auto",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{selectedShadeUi.presetId ?? "Shade"}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              shade (%)
              <input
                type="number"
                step="1"
                value={Math.round(clampNumber(selectedShadeUi.coolingFactor ?? 0, 0, 1) * 100)}
                onChange={(e) => {
                  const v = clampNumber(e.target.value, 0, 100) / 100;
                  updateShadeInstance(selectedShadeUi.id, { coolingFactor: v });
                }}
                style={{
                  padding: "6px 8px",
                  borderRadius: 10,
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  background: "rgba(0, 0, 0, 0.25)",
                  color: "#e5e7eb",
                  outline: "none",
                  width: 92,
                }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              scale
              <input
                type="text"
                inputMode="decimal"
                value={shadeScaleDraft}
                onChange={(e) => setShadeScaleDraft(e.target.value)}
                onBlur={() => {
                  const parsed = parseUserNumber(shadeScaleDraft);
                  if (parsed === null) {
                    const v = Number(selectedShadeUi.scale ?? 1);
                    setShadeScaleDraft(Number.isFinite(v) ? String(v) : "1");
                    return;
                  }
                  updateShadeInstance(selectedShadeUi.id, { scale: clampNumber(parsed, SHADE_SCALE_MIN, SHADE_SCALE_MAX) });
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.currentTarget.blur();
                }}
                style={{
                  padding: "6px 8px",
                  borderRadius: 10,
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  background: "rgba(0, 0, 0, 0.25)",
                  color: "#e5e7eb",
                  outline: "none",
                  width: 92,
                }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              rotY
              <input
                type="number"
                step="1"
                value={Number(selectedShadeUi.rotationY ?? 0)}
                onChange={(e) => updateShadeInstance(selectedShadeUi.id, { rotationY: Number(e.target.value) })}
                style={{
                  padding: "6px 8px",
                  borderRadius: 10,
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  background: "rgba(0, 0, 0, 0.25)",
                  color: "#e5e7eb",
                  outline: "none",
                  width: 92,
                }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => removeShadeInstance(selectedShadeUi.id)}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255, 255, 255, 0.15)",
                background: "rgba(239,68,68,0.85)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => clearSelectedShade()}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255, 255, 255, 0.15)",
                background: "rgba(17, 24, 39, 0.8)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {selectedBuildingUi ? (
        <div
          style={{
            position: "absolute",
            left: selectedBuildingMenuPos?.x ?? 10,
            top: selectedBuildingMenuPos?.y ?? 10,
            transform: "translate(-50%, calc(-100% - 14px))",
            zIndex: 5,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255, 255, 255, 0.18)",
            background: "rgba(10, 18, 30, 0.72)",
            color: "rgba(255, 255, 255, 0.95)",
            minWidth: 220,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{selectedBuildingUi.label ?? "Building"}</div>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            height (m)
            <input
              type="number"
              step="0.1"
              value={selectedBuildingHeight}
              onChange={(e) => setSelectedBuildingHeight(e.target.value)}
              style={{
                padding: "6px 8px",
                borderRadius: 10,
                border: "1px solid rgba(255, 255, 255, 0.15)",
                background: "rgba(0, 0, 0, 0.25)",
                color: "#e5e7eb",
                outline: "none",
              }}
            />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                const h = Number(selectedBuildingHeight);
                if (!Number.isFinite(h)) return;
                const mesh = selectedBuildingRef.current?.mesh;
                const key = mesh?.userData?.building?.key;
                if (key) {
                  rebuildBuildingHeightByKey(key, h);
                } else {
                  rebuildSelectedBuildingHeight(h);
                }
                if (mesh?.userData?.building) {
                  markBuildingModified(mesh, mesh.userData.building, h);
                }
                setSelectedBuildingUi((prev) => (prev ? { ...prev, height: h } : { height: h }));
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255, 255, 255, 0.15)",
                background: "rgba(17, 24, 39, 0.8)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => clearSelectedBuilding()}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255, 255, 255, 0.15)",
                background: "rgba(17, 24, 39, 0.8)",
                color: "#e5e7eb",
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {shadeUiInstances.length || modifiedBuildingsUi?.length ? (
        <div
          style={{
            position: "absolute",
            right: 10,
            top: toolbarBottomPx,
            zIndex: 5,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255, 255, 255, 0.18)",
            background: "rgba(10, 18, 30, 0.72)",
            color: "rgba(255, 255, 255, 0.95)",
            minWidth: 260,
            maxWidth: 320,
            pointerEvents: "auto",
          }}
        >
          {shadeUiInstances.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontWeight: 700 }}>Shades</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {shadeUiInstances.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => {
                      setShadeDropdownSelectedId(s.id);
                      selectedShadeRef.current = s.id;
                      setSelectedShadeUi({ ...s });
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "6px 8px",
                      borderRadius: 10,
                      border: "1px solid rgba(255, 255, 255, 0.12)",
                      background: "rgba(0, 0, 0, 0.18)",
                      cursor: "pointer",
                      opacity: selectedShadeRef.current === s.id ? 1 : 0.92,
                    }}
                    title="Click to select. Click in 3D to edit settings."
                  >
                    <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.presetId ?? "Shade"}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        removeShadeInstance(s.id);
                      }}
                      title="Delete shade"
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 8,
                        border: "1px solid rgba(255,255,255,0.15)",
                        background: "rgba(239, 68, 68, 0.85)",
                        color: "#0b1220",
                        cursor: "pointer",
                        fontWeight: 900,
                        lineHeight: "24px",
                        padding: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {modifiedBuildingsUi?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontWeight: 700 }}>Modified buildings</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {modifiedBuildingsUi.map((b) => (
                  <div
                    key={b.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "6px 8px",
                      borderRadius: 10,
                      border: "1px solid rgba(255, 255, 255, 0.12)",
                      background: "rgba(0, 0, 0, 0.18)",
                    }}
                  >
                    <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {b.label ?? "Building"}
                    </div>
                    <button
                      type="button"
                      onClick={() => revertModifiedBuilding(b.key)}
                      title="Revert building"
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 8,
                        border: "1px solid rgba(255,255,255,0.15)",
                        background: "rgba(239, 68, 68, 0.85)",
                        color: "#0b1220",
                        cursor: "pointer",
                        fontWeight: 900,
                        lineHeight: "24px",
                        padding: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export default TerrainOsmViewer;

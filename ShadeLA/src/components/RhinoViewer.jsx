import React, { useEffect, useRef } from "react";
import * as THREE from "three";

function RhinoViewer() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const targetRef = useRef(new THREE.Vector3(0, 0, 0));
  const isDraggingRef = useRef(false);
  const lastPosRef = useRef(null);

  const groupsRef = useRef({ buildings: null, roads: null, parks: null, water: null });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || rendererRef.current) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);

    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;
    renderer.setSize(width, height, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#f4f4f4");

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    camera.position.set(20, 20, 20);
    targetRef.current.set(0, 0, 0);
    camera.lookAt(targetRef.current);

    const light = new THREE.DirectionalLight(0xffffff, 0.9);
    light.position.set(10, 20, 15);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x808080));

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

    let cancelled = false;

    const animate = () => {
      if (cancelled) return;
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
      requestAnimationFrame(animate);
    };
    animate();

    const handleResize = () => {
      if (!rendererRef.current || !cameraRef.current || !canvasRef.current) return;
      const w = canvasRef.current.clientWidth || canvasRef.current.width;
      const h = canvasRef.current.clientHeight || canvasRef.current.height;
      rendererRef.current.setSize(w, h, false);
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
    };
    window.addEventListener("resize", handleResize);

    const handleWheel = (ev) => {
      if (!cameraRef.current) return;
      ev.preventDefault();
      const cameraNow = cameraRef.current;
      const target = targetRef.current;
      const dir = new THREE.Vector3().subVectors(cameraNow.position, target);
      const factor = ev.deltaY > 0 ? 1.1 : 0.9;
      dir.multiplyScalar(factor);
      cameraNow.position.copy(new THREE.Vector3().addVectors(target, dir));
      cameraNow.lookAt(target);
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });

    const handleMouseDown = (ev) => {
      isDraggingRef.current = true;
      lastPosRef.current = { x: ev.clientX, y: ev.clientY };
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      lastPosRef.current = null;
    };

    const handleMouseMove = (ev) => {
      if (!isDraggingRef.current || !cameraRef.current || !lastPosRef.current || !canvasRef.current) return;
      const { clientWidth, clientHeight } = canvasRef.current;
      const dx = (ev.clientX - lastPosRef.current.x) / clientWidth;
      const dy = (ev.clientY - lastPosRef.current.y) / clientHeight;
      lastPosRef.current = { x: ev.clientX, y: ev.clientY };

      const cameraNow = cameraRef.current;
      const target = targetRef.current;
      const offset = new THREE.Vector3().subVectors(cameraNow.position, target);
      const spherical = new THREE.Spherical().setFromVector3(offset);

      const ROTATE_SPEED = 2.5;
      spherical.theta -= dx * ROTATE_SPEED;
      spherical.phi -= dy * ROTATE_SPEED;
      const EPS = 0.01;
      spherical.phi = Math.max(EPS, Math.min(Math.PI - EPS, spherical.phi));

      offset.setFromSpherical(spherical);
      cameraNow.position.copy(new THREE.Vector3().addVectors(target, offset));
      cameraNow.lookAt(target);
    };

    canvas.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("mouseleave", handleMouseUp);
    canvas.addEventListener("mousemove", handleMouseMove);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", handleResize);
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
      canvas.removeEventListener("mouseleave", handleMouseUp);
      canvas.removeEventListener("mousemove", handleMouseMove);

      try {
        renderer.dispose();
      } catch {
        // ignore
      }

      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  async function renderBbox(bbox) {
    if (!sceneRef.current || !cameraRef.current) return;

    const scene = sceneRef.current;

    // remove previous groups
    const prev = groupsRef.current;
    for (const key of Object.keys(prev)) {
      const g = prev[key];
      if (!g) continue;
      scene.remove(g);
      g.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) m.dispose?.();
        }
      });
    }
    groupsRef.current = { buildings: null, roads: null, parks: null, water: null };

    const [west, south, east, north] = bbox;

    const res = await fetch("/api/osm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bbox: [west, south, east, north] }),
    });
    if (!res.ok) return;
    const geojson = await res.json();

    const allFeatures = geojson.features || [];
    if (!allFeatures.length) return;

    const buildings = allFeatures.filter((f) => {
      const props = f.properties || {};
      return props.building || props["building:part"] || props["building:use"];
    });
    if (!buildings.length) return;

    // limit for browser
    const featuresWithHeight = buildings
      .map((f) => {
        const props = f.properties || {};
        let h = 0;
        if (props.height) {
          const parsed = parseFloat(String(props.height));
          if (!Number.isNaN(parsed)) h = parsed;
        } else if (props["building:height"]) {
          const parsed = parseFloat(String(props["building:height"]));
          if (!Number.isNaN(parsed)) h = parsed;
        } else if (props.levels || props["building:levels"]) {
          const lv = parseFloat(String(props.levels || props["building:levels"])) || 0;
          h = lv * 3.0;
        } else {
          h = 10.0;
        }
        return { feature: f, h };
      })
      .sort((a, b) => b.h - a.h)
      .slice(0, 3000)
      .map((x) => x.feature);

    const buildingsGroup = new THREE.Group();
    const roadsGroup = new THREE.Group();
    const parksGroup = new THREE.Group();
    const waterGroup = new THREE.Group();

    const cx = (west + east) / 2;
    const cy = (south + north) / 2;
    const spanLon = Math.max(1e-6, east - west);
    const spanLat = Math.max(1e-6, north - south);
    const halfSize = 50;

    const allPoints = [];

    for (const f of featuresWithHeight) {
      const geom = f.geometry;
      if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue;

      const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      for (const poly of polygons) {
        const ring = poly[0];
        if (!ring || ring.length < 3) continue;

        const shapePts = [];
        for (const [lon, lat] of ring) {
          const nx = (lon - cx) / spanLon;
          const ny = (lat - cy) / spanLat;
          const x = nx * halfSize * 2;
          const y = ny * halfSize * 2;
          shapePts.push(new THREE.Vector2(x, y));
        }

        const shape = new THREE.Shape(shapePts);

        const props = f.properties || {};
        let h = 10;
        if (props.height) {
          const parsed = parseFloat(String(props.height));
          if (!Number.isNaN(parsed)) h = parsed;
        } else if (props["building:height"]) {
          const parsed = parseFloat(String(props["building:height"]));
          if (!Number.isNaN(parsed)) h = parsed;
        } else if (props.levels || props["building:levels"]) {
          const lv = parseFloat(String(props.levels || props["building:levels"])) || 0;
          h = lv * 3.0;
        }

        const height = Math.min(30, Math.max(2, h / 12));

        const extrudeGeom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
        extrudeGeom.rotateX(-Math.PI / 2);

        const mat = new THREE.MeshStandardMaterial({
          color: 0xb0b0b0,
          metalness: 0.1,
          roughness: 0.8,
        });

        const mesh = new THREE.Mesh(extrudeGeom, mat);
        buildingsGroup.add(mesh);

        extrudeGeom.computeBoundingBox();
        if (extrudeGeom.boundingBox) {
          const bb = extrudeGeom.boundingBox;
          allPoints.push(new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z));
          allPoints.push(new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z));
        }
      }
    }

    const projectPoint = (lon, lat) => {
      const nx = (lon - cx) / spanLon;
      const ny = (lat - cy) / spanLat;
      const x = nx * halfSize * 2;
      const y = ny * halfSize * 2;
      return new THREE.Vector3(x, y, 0);
    };

    for (const f of allFeatures) {
      const geom = f.geometry;
      const props = f.properties || {};
      if (!geom || !geom.type) continue;

      if (props.highway) {
        if (geom.type === "LineString") {
          const pts = geom.coordinates.map(([lon, lat]) => projectPoint(lon, lat));
          if (pts.length >= 2) {
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            geo.rotateX(-Math.PI / 2);
            const mat = new THREE.LineBasicMaterial({ color: 0xaaaaaa });
            roadsGroup.add(new THREE.Line(geo, mat));
          }
        } else if (geom.type === "MultiLineString") {
          for (const lineCoords of geom.coordinates) {
            const pts = lineCoords.map(([lon, lat]) => projectPoint(lon, lat));
            if (pts.length < 2) continue;
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            geo.rotateX(-Math.PI / 2);
            const mat = new THREE.LineBasicMaterial({ color: 0xaaaaaa });
            roadsGroup.add(new THREE.Line(geo, mat));
          }
        }
        continue;
      }

      const isPark = props.leisure === "park" || props.landuse === "grass";
      const isWater = props.natural === "water" || props.waterway === "riverbank";
      if (!isPark && !isWater) continue;
      if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") continue;

      const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      for (const poly of polygons) {
        const ring = poly[0];
        if (!ring || ring.length < 3) continue;

        const shapePts = [];
        for (const [lon, lat] of ring) {
          const nx = (lon - cx) / spanLon;
          const ny = (lat - cy) / spanLat;
          const x = nx * halfSize * 2;
          const y = ny * halfSize * 2;
          shapePts.push(new THREE.Vector2(x, y));
        }

        const shape = new THREE.Shape(shapePts);
        const geo = new THREE.ShapeGeometry(shape);
        geo.rotateX(-Math.PI / 2);

        if (isPark) {
          const mat = new THREE.MeshStandardMaterial({ color: 0x66aa66, roughness: 0.9, metalness: 0.0 });
          parksGroup.add(new THREE.Mesh(geo, mat));
        } else if (isWater) {
          const mat = new THREE.MeshStandardMaterial({ color: 0x4a7bd1, roughness: 0.8, metalness: 0.1 });
          waterGroup.add(new THREE.Mesh(geo, mat));
        }
      }
    }

    if (!allPoints.length) return;

    const overallBB = new THREE.Box3().setFromPoints(allPoints);
    const center = overallBB.getCenter(new THREE.Vector3());
    const size = overallBB.getSize(new THREE.Vector3());

    buildingsGroup.position.sub(center);
    roadsGroup.position.sub(center);
    parksGroup.position.sub(center);
    waterGroup.position.sub(center);

    scene.add(roadsGroup);
    scene.add(parksGroup);
    scene.add(waterGroup);
    scene.add(buildingsGroup);

    groupsRef.current = { buildings: buildingsGroup, roads: roadsGroup, parks: parksGroup, water: waterGroup };

    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.8 || 20;
    cameraRef.current.position.set(dist, dist, dist);
    targetRef.current.set(0, 0, 0);
    cameraRef.current.lookAt(targetRef.current);
  }

  useEffect(() => {
    const handler = (event) => {
      const data = event?.data;
      if (!data || data.type !== "cadmapper:bbox" || !Array.isArray(data.bbox)) return;
      const bbox = data.bbox;
      if (bbox.length !== 4) return;
      renderBbox(bbox);
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", display: "block", background: "#000" }}
    />
  );
}

export default RhinoViewer;

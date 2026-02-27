import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import rhino3dm from "rhino3dm/rhino3dm.module.js";
import rhino3dmWasmUrl from "rhino3dm/rhino3dm.wasm?url";

function RhinoViewer() {
  const [drawMode, setDrawMode] = useState(false);
  const [, forceUiUpdate] = useState(0);
  const drawModeRef = useRef(false);
  const [webglError, setWebglError] = useState(null);
  const [modelStatus, setModelStatus] = useState("");
  const [rhinoReady, setRhinoReady] = useState(false);
  const [baseModelReady, setBaseModelReady] = useState(false);
  const waitingForCanvasSizeRef = useRef(false);
  const initAttemptedRef = useRef(false);
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const targetRef = useRef(new THREE.Vector3(0, 0, 0));
  const desiredCameraPosRef = useRef(null);
  const desiredTargetRef = useRef(null);
  const isDraggingRef = useRef(false);
  const lastPosRef = useRef(null);

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

  const drawGroupRef = useRef(null);
  const drawStateRef = useRef({ polylines: [], current: [] });
  const currentLineRef = useRef(null);
  const previewLineRef = useRef(null);

  const SCENE_UNITS_TO_METERS = 1;

  const computePolylineLengthMeters = (pts) => {
    if (!Array.isArray(pts) || pts.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!a || !b) continue;
      total += a.distanceTo(b);
    }
    return total * SCENE_UNITS_TO_METERS;
  };

  const groupsRef = useRef({ buildings: null, roads: null, parks: null, water: null });
  const ghGroupRef = useRef(null);
  const rhinoRef = useRef(null);
  const pendingGhSchemaRef = useRef(null);
  const pendingBboxRef = useRef(null);
  const pendingBboxFlushRafRef = useRef(0);
  const pendingBboxStartFlushRef = useRef(null);
  const osmRenderSeqRef = useRef(0);
  const osmAbortRef = useRef(null);
  const pendingCurveRequestIdRef = useRef(null);
  const pendingCurveRequestTimerRef = useRef(0);

  useEffect(() => {
    drawModeRef.current = drawMode;
    if (drawMode) {
      setModelStatus((s) => (s && s.startsWith("Draw:")) ? s : "Draw: click on canvas to add points");
    }
  }, [drawMode]);

  useEffect(() => {
    let rafId = 0;
    let cancelled = false;

    let removeWebglContextHandlers = null;

    const cleanupRef = { current: null };

    const schedulePendingBboxFlush = () => {
      if (cancelled) return;
      if (pendingBboxFlushRafRef.current) return;

      const tick = () => {
        if (cancelled) return;
        if (!pendingBboxRef.current) {
          pendingBboxFlushRafRef.current = 0;
          return;
        }

        if (sceneRef.current && cameraRef.current && rendererRef.current) {
          const bb = pendingBboxRef.current;
          pendingBboxRef.current = null;
          pendingBboxFlushRafRef.current = 0;
          setModelStatus("Loading OSM...");
          requestAnimationFrame(() => renderBbox(bb));
          return;
        }

        pendingBboxFlushRafRef.current = requestAnimationFrame(tick);
      };

      pendingBboxFlushRafRef.current = requestAnimationFrame(tick);
    };

    pendingBboxStartFlushRef.current = schedulePendingBboxFlush;

    const initIfReady = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) {
        rafId = requestAnimationFrame(initIfReady);
        return;
      }
      if (rendererRef.current) return;
      if (initAttemptedRef.current) {
        // Fast Refresh / partial failures can leave initAttempted=true while renderer/scene/camera are null.
        // In that case, allow a recovery re-init.
        if (!sceneRef.current && !cameraRef.current) {
          console.log("[Viewer] init recovery: resetting initAttemptedRef");
          initAttemptedRef.current = false;
        } else {
          return;
        }
      }

      const w0 = canvas.clientWidth;
      const h0 = canvas.clientHeight;
      if (!w0 || !h0) {
        if (!waitingForCanvasSizeRef.current) {
          waitingForCanvasSizeRef.current = true;
          setModelStatus("Waiting for canvas size...");
        }
        rafId = requestAnimationFrame(initIfReady);
        return;
      }

      waitingForCanvasSizeRef.current = false;

      if (typeof console !== "undefined" && typeof console.error !== "function") {
        try {
          console.error = console.log;
        } catch {
          // ignore
        }
      }

      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      } catch (e) {
        initAttemptedRef.current = true;
        setModelStatus("WebGL init failed");
        setWebglError(String(e?.message || e));
        return;
      }

      initAttemptedRef.current = true;

      if (!renderer) {
        setModelStatus("WebGL init failed");
        setWebglError("WebGL renderer could not be created");
        return;
      }

      renderer.setPixelRatio(window.devicePixelRatio || 1);
      const width = canvas.clientWidth || 800;
      const height = canvas.clientHeight || 600;
      renderer.setSize(width, height, false);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#f4f4f4");

      // Debug visuals: ensures we see *something* even before GH/OSM overlays are added.
      scene.add(new THREE.AxesHelper(5));
      scene.add(new THREE.GridHelper(2000, 40));

      const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 5_000_000);
      camera.position.set(20, 20, 20);
      targetRef.current.set(0, 0, 0);
      camera.lookAt(targetRef.current);

      desiredCameraPosRef.current = camera.position.clone();
      desiredTargetRef.current = targetRef.current.clone();

      const light = new THREE.DirectionalLight(0xffffff, 0.9);
      light.position.set(10, 20, 15);
      scene.add(light);
      scene.add(new THREE.AmbientLight(0x808080));

      const drawGroup = new THREE.Group();
      drawGroup.name = "user-drawings";
      scene.add(drawGroup);
      drawGroupRef.current = drawGroup;

      rendererRef.current = renderer;
      sceneRef.current = scene;
      cameraRef.current = camera;

      const onContextLost = (ev) => {
        try {
          ev.preventDefault?.();
        } catch {
          // ignore
        }
        setModelStatus("WebGL context lost");
        setWebglError("WebGL context lost");

        try {
          rendererRef.current?.dispose?.();
        } catch {
          // ignore
        }
        rendererRef.current = null;
        cameraRef.current = null;
        sceneRef.current = null;
        initAttemptedRef.current = false;
      };

      const onContextRestored = () => {
        setWebglError(null);
        setModelStatus("WebGL context restored — reinitializing...");
        rendererRef.current = null;
        cameraRef.current = null;
        sceneRef.current = null;
        initAttemptedRef.current = false;
        waitingForCanvasSizeRef.current = false;
        rafId = requestAnimationFrame(initIfReady);
      };

      canvas.addEventListener("webglcontextlost", onContextLost, false);
      canvas.addEventListener("webglcontextrestored", onContextRestored, false);
      removeWebglContextHandlers = () => {
        canvas.removeEventListener("webglcontextlost", onContextLost, false);
        canvas.removeEventListener("webglcontextrestored", onContextRestored, false);
      };

      setModelStatus(`Viewer ready (${width}x${height})`);

      if (pendingBboxRef.current && Array.isArray(pendingBboxRef.current) && pendingBboxRef.current.length === 4) {
        const bb = pendingBboxRef.current;
        pendingBboxRef.current = null;
        setModelStatus("Loading OSM...");
        requestAnimationFrame(() => renderBbox(bb));
      }

      schedulePendingBboxFlush();

      (async () => {
        try {
          rhinoRef.current = await rhino3dm({ locateFile: () => rhino3dmWasmUrl });
          setRhinoReady(true);

          // If GH asked for curves before rhino3dm finished loading, answer now.
          if (pendingCurveRequestIdRef.current) {
            const requestId = pendingCurveRequestIdRef.current;
            pendingCurveRequestIdRef.current = null;
            if (pendingCurveRequestTimerRef.current) {
              window.clearTimeout(pendingCurveRequestTimerRef.current);
              pendingCurveRequestTimerRef.current = 0;
            }
            const items = sendDrawingsToGrasshopper() || [];
            console.log("[GH] responding queued curves", { requestId, count: items.length });
            window.dispatchEvent(
              new CustomEvent("grasshopper:curves-response", {
                detail: { requestId, paramName: "cr", items },
              })
            );
          }

          if (pendingGhSchemaRef.current) {
            addGhOverlay(pendingGhSchemaRef.current);
            pendingGhSchemaRef.current = null;
          }
        } catch {
          rhinoRef.current = null;
          setRhinoReady(false);
          setModelStatus("Rhino3dm failed to load");
        }
      })();

      const animate = () => {
        if (cancelled) return;
        if (rendererRef.current && sceneRef.current && cameraRef.current) {
          const cam = cameraRef.current;
          const desiredPos = desiredCameraPosRef.current;
          const desiredTarget = desiredTargetRef.current;
          if (desiredPos && desiredTarget) {
            const DAMPING = 0.18;
            cam.position.lerp(desiredPos, DAMPING);
            targetRef.current.lerp(desiredTarget, DAMPING);
            cam.lookAt(targetRef.current);
          }
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
        const canvasEl = canvasRef.current;
        if (!canvasEl) return;

        const rect = canvasEl.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((ev.clientX - rect.left) / rect.width) * 2 - 1,
          -(((ev.clientY - rect.top) / rect.height) * 2 - 1)
        );

        const target = targetRef.current;

        const rayOrigin = cameraNow.position.clone();
        const rayDir = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(cameraNow).sub(rayOrigin).normalize();

        // Intersect the mouse ray with a plane through the current target and perpendicular to the camera.
        const planeNormal = new THREE.Vector3().subVectors(target, cameraNow.position).normalize();
        const denom = planeNormal.dot(rayDir);
        let zoomPoint = target.clone();
        if (Math.abs(denom) > 1e-6) {
          const t = planeNormal.dot(new THREE.Vector3().subVectors(target, rayOrigin)) / denom;
          if (t > 0) zoomPoint = rayOrigin.clone().add(rayDir.clone().multiplyScalar(t));
        }

        // Stronger zoom that scales with wheel delta.
        // factor > 1  => zoom out, factor < 1 => zoom in.
        const ZOOM_SPEED = 0.0025;
        const factor = Math.exp(ev.deltaY * ZOOM_SPEED);
        const newPos = zoomPoint.clone().add(cameraNow.position.clone().sub(zoomPoint).multiplyScalar(factor));

        // Keep the point under the cursor stable by shifting the orbit target.
        const newTarget = zoomPoint.clone().add(target.clone().sub(zoomPoint).multiplyScalar(factor));

        // Prevent the camera from crossing the target (keeps controls stable) but still
        // allow very close zoom.
        const MIN_DISTANCE = 0.03;
        const toTarget = newPos.clone().sub(newTarget);
        const dist = toTarget.length();
        if (Number.isFinite(dist) && dist < MIN_DISTANCE) {
          toTarget.setLength(MIN_DISTANCE);
          newPos.copy(newTarget.clone().add(toTarget));
        }

        desiredCameraPosRef.current = newPos;
        desiredTargetRef.current = newTarget;
      };
      canvas.addEventListener("wheel", handleWheel, { passive: false });

      const raycaster = new THREE.Raycaster();
      const handleDoubleClick = (ev) => {
        if (!cameraRef.current || !sceneRef.current || !canvasRef.current) return;
        const cameraNow = cameraRef.current;
        const canvasEl = canvasRef.current;
        const rect = canvasEl.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((ev.clientX - rect.left) / rect.width) * 2 - 1,
          -(((ev.clientY - rect.top) / rect.height) * 2 - 1)
        );

        raycaster.setFromCamera(ndc, cameraNow);

        const cityGroups = groupsRef.current;
        const roots = [
          cityGroups?.buildings,
          cityGroups?.roads,
          cityGroups?.parks,
          cityGroups?.water,
          ghGroupRef.current,
          drawGroupRef.current,
        ].filter(Boolean);

        const hits = raycaster.intersectObjects(roots, true);
        if (!hits || hits.length < 1) return;

        const p = hits[0]?.point;
        if (!p) return;

        // Set orbit target to the clicked point. Keep current camera distance so it feels like "focus".
        const currentTarget = (desiredTargetRef.current || targetRef.current).clone();
        const currentPos = (desiredCameraPosRef.current || cameraNow.position).clone();
        const offset = currentPos.sub(currentTarget);
        desiredTargetRef.current = p.clone();
        desiredCameraPosRef.current = p.clone().add(offset);
      };
      canvas.addEventListener("dblclick", handleDoubleClick);

      const screenToGround = (ev) => {
        if (!cameraRef.current || !canvasRef.current) return null;
        const cameraNow = cameraRef.current;
        const canvasEl = canvasRef.current;
        const rect = canvasEl.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((ev.clientX - rect.left) / rect.width) * 2 - 1,
          -(((ev.clientY - rect.top) / rect.height) * 2 - 1)
        );

        const origin = cameraNow.position.clone();
        const dir = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(cameraNow).sub(origin).normalize();

        // Ground plane: Y = 0
        const denom = dir.y;
        if (Math.abs(denom) < 1e-6) return null;
        const t = -origin.y / denom;
        if (t <= 0) return null;
        return origin.add(dir.multiplyScalar(t));
      };

      const buildLineGeometry = (pts) => {
        const positions = new Float32Array(pts.length * 3);
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          positions[i * 3 + 0] = p.x;
          positions[i * 3 + 1] = p.y;
          positions[i * 3 + 2] = p.z;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        return geo;
      };

      const updateCurrentLine = () => {
        const current = drawStateRef.current.current;
        if (!drawGroupRef.current) return;

        if (currentLineRef.current) {
          drawGroupRef.current.remove(currentLineRef.current);
          currentLineRef.current.geometry?.dispose?.();
          currentLineRef.current = null;
        }

        if (current.length < 2) return;
        const geo = buildLineGeometry(current);
        const mat = new THREE.LineBasicMaterial({ color: 0x22c55e, linewidth: 2 });
        const line = new THREE.Line(geo, mat);
        line.frustumCulled = false;
        currentLineRef.current = line;
        drawGroupRef.current.add(line);
      };

      const updatePreviewLine = (mousePt) => {
        const current = drawStateRef.current.current;
        if (!drawGroupRef.current) return;

        if (previewLineRef.current) {
          drawGroupRef.current.remove(previewLineRef.current);
          previewLineRef.current.geometry?.dispose?.();
          previewLineRef.current = null;
        }

        if (!mousePt || current.length < 1) return;
        const pts = [...current, mousePt];
        const geo = buildLineGeometry(pts);
        const mat = new THREE.LineDashedMaterial({ color: 0x93c5fd, dashSize: 0.6, gapSize: 0.35 });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        line.frustumCulled = false;
        previewLineRef.current = line;
        drawGroupRef.current.add(line);
      };

      const handleMouseDown = (ev) => {
        if (drawModeRef.current) {
          ev.preventDefault();
          const pt = screenToGround(ev);
          if (!pt) {
            setModelStatus("Draw: no ground intersection (try orbit/zoom and click again)");
            return;
          }
          const current = drawStateRef.current.current;
          current.push(pt);
          const lenM = computePolylineLengthMeters(current);
          setModelStatus(
            `Draw: ${current.length} pts, ${lenM.toFixed(2)} m (last: ${pt.x.toFixed(2)}, ${pt.y.toFixed(2)}, ${pt.z.toFixed(2)})`
          );
          updateCurrentLine();
          updatePreviewLine(pt);
          forceUiUpdate((x) => x + 1);
          return;
        }

        isDraggingRef.current = true;
        lastPosRef.current = { x: ev.clientX, y: ev.clientY };
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        lastPosRef.current = null;
      };

      const handleMouseMove = (ev) => {
        if (drawModeRef.current) {
          const pt = screenToGround(ev);
          updatePreviewLine(pt);
          return;
        }

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
        const nextPos = new THREE.Vector3().addVectors(target, offset);
        desiredCameraPosRef.current = nextPos;
        desiredTargetRef.current = target.clone();
      };

      canvas.addEventListener("mousedown", handleMouseDown);
      window.addEventListener("mouseup", handleMouseUp);
      canvas.addEventListener("mouseleave", handleMouseUp);
      canvas.addEventListener("mousemove", handleMouseMove);

      const cleanup = () => {
        window.removeEventListener("resize", handleResize);
        canvas.removeEventListener("wheel", handleWheel);
        canvas.removeEventListener("dblclick", handleDoubleClick);
        canvas.removeEventListener("mousedown", handleMouseDown);
        window.removeEventListener("mouseup", handleMouseUp);
        canvas.removeEventListener("mouseleave", handleMouseUp);
        canvas.removeEventListener("mousemove", handleMouseMove);
        removeWebglContextHandlers?.();
      };

      cleanupRef.current = cleanup;
    };
    initIfReady();

    // If a bbox was queued before init completes, keep checking until the viewer becomes ready.
    schedulePendingBboxFlush();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (pendingBboxFlushRafRef.current) {
        cancelAnimationFrame(pendingBboxFlushRafRef.current);
        pendingBboxFlushRafRef.current = 0;
      }
      pendingBboxStartFlushRef.current = null;
      cleanupRef.current?.();

      if (rendererRef.current) {
        rendererRef.current.dispose?.();
        rendererRef.current = null;
      }
      if (sceneRef.current) {
        if (drawGroupRef.current) {
          sceneRef.current.remove(drawGroupRef.current);
          clearGroup(drawGroupRef.current);
          drawGroupRef.current = null;
        }
        if (ghGroupRef.current) {
          sceneRef.current.remove(ghGroupRef.current);
          clearGroup(ghGroupRef.current);
          ghGroupRef.current = null;
        }
        sceneRef.current = null;
      }
      cameraRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onReq = (ev) => {
      const detail = ev?.detail || {};
      const requestId = detail.requestId;
      const overlayOnly = detail.overlayOnly !== false;
      const width = Number.isFinite(detail.width) ? Math.max(64, Math.floor(detail.width)) : 1280;
      const height = Number.isFinite(detail.height) ? Math.max(64, Math.floor(detail.height)) : 720;

      const respond = (payload) => {
        try {
          window.dispatchEvent(new CustomEvent("grasshopper:render-snapshot", { detail: { requestId, ...payload } }));
        } catch {
          // ignore
        }
      };

      if (!requestId) {
        respond({ ok: false, error: "Missing requestId" });
        return;
      }

      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;

      if (!renderer || !scene || !camera) {
        respond({ ok: false, error: "Viewer not ready" });
        return;
      }

      if (overlayOnly && (!ghGroupRef.current || ghGroupRef.current.children.length < 1)) {
        respond({ ok: false, error: "No Grasshopper overlay to render" });
        return;
      }

      const prev = {
        bg: scene.background,
        groupsVisible: {
          buildings: groupsRef.current?.buildings?.visible,
          roads: groupsRef.current?.roads?.visible,
          parks: groupsRef.current?.parks?.visible,
          water: groupsRef.current?.water?.visible,
        },
        drawVisible: drawGroupRef.current?.visible,
      };

      const prevSize = new THREE.Vector2();
      renderer.getSize(prevSize);
      const prevPixelRatio = renderer.getPixelRatio?.() || 1;

      const rt = new THREE.WebGLRenderTarget(width, height, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });

      try {
        scene.background = new THREE.Color("#f4f4f4");

        if (overlayOnly) {
          const g = groupsRef.current;
          if (g?.buildings) g.buildings.visible = false;
          if (g?.roads) g.roads.visible = false;
          if (g?.parks) g.parks.visible = false;
          if (g?.water) g.water.visible = false;
          if (drawGroupRef.current) drawGroupRef.current.visible = false;
        }

        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        renderer.setRenderTarget(rt);
        renderer.render(scene, camera);

        const pixels = new Uint8Array(width * height * 4);
        renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          respond({ ok: false, error: "2D context unavailable" });
          return;
        }

        const imgData = ctx.createImageData(width, height);

        for (let y = 0; y < height; y++) {
          const srcRow = height - 1 - y;
          const srcOffset = srcRow * width * 4;
          const dstOffset = y * width * 4;
          imgData.data.set(pixels.subarray(srcOffset, srcOffset + width * 4), dstOffset);
        }

        ctx.putImageData(imgData, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        respond({ ok: true, dataUrl });
      } catch (e) {
        respond({ ok: false, error: String(e?.message || e) });
      } finally {
        try {
          renderer.setRenderTarget(null);
        } catch {
          // ignore
        }
        try {
          rt.dispose?.();
        } catch {
          // ignore
        }

        try {
          renderer.setPixelRatio(prevPixelRatio);
          renderer.setSize(prevSize.x, prevSize.y, false);
        } catch {
          // ignore
        }

        try {
          scene.background = prev.bg;
          const g = groupsRef.current;
          if (g?.buildings && typeof prev.groupsVisible.buildings === "boolean") g.buildings.visible = prev.groupsVisible.buildings;
          if (g?.roads && typeof prev.groupsVisible.roads === "boolean") g.roads.visible = prev.groupsVisible.roads;
          if (g?.parks && typeof prev.groupsVisible.parks === "boolean") g.parks.visible = prev.groupsVisible.parks;
          if (g?.water && typeof prev.groupsVisible.water === "boolean") g.water.visible = prev.groupsVisible.water;
          if (drawGroupRef.current && typeof prev.drawVisible === "boolean") drawGroupRef.current.visible = prev.drawVisible;
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener("grasshopper:request-render-snapshot", onReq);
    return () => window.removeEventListener("grasshopper:request-render-snapshot", onReq);
  }, []);

  useEffect(() => {
    const onReqObj = (ev) => {
      const detail = ev?.detail || {};
      const requestId = detail.requestId;

      const respond = (payload) => {
        try {
          window.dispatchEvent(new CustomEvent("grasshopper:obj", { detail: { requestId, ...payload } }));
        } catch {
          // ignore
        }
      };

      if (!requestId) {
        respond({ ok: false, error: "Missing requestId" });
        return;
      }

      if (!ghGroupRef.current || ghGroupRef.current.children.length < 1) {
        respond({ ok: false, error: "No Grasshopper overlay to export" });
        return;
      }

      const overlay = ghGroupRef.current;
      overlay.updateMatrixWorld(true);

      try {
        let out = "";
        let vOffset = 1;

        const toMeshList = () => {
          const meshes = [];
          overlay.traverse((obj) => {
            if (!obj) return;
            if (obj.isMesh && obj.geometry) meshes.push(obj);
          });
          return meshes;
        };

        const meshes = toMeshList();
        if (!meshes.length) {
          respond({ ok: false, error: "Overlay contains no meshes" });
          return;
        }

        for (const mesh of meshes) {
          const geom = mesh.geometry;
          if (!geom) continue;

          const posAttr = geom.attributes?.position;
          if (!posAttr || !posAttr.array) continue;

          const world = mesh.matrixWorld;
          const v = new THREE.Vector3();

          out += `o ${mesh.name || "mesh"}\n`;

          for (let i = 0; i < posAttr.count; i++) {
            v.fromBufferAttribute(posAttr, i);
            v.applyMatrix4(world);
            out += `v ${v.x} ${v.y} ${v.z}\n`;
          }

          const idx = geom.index;
          if (idx && idx.array && idx.count >= 3) {
            for (let i = 0; i < idx.count; i += 3) {
              const a = idx.getX(i + 0) + vOffset;
              const b = idx.getX(i + 1) + vOffset;
              const c = idx.getX(i + 2) + vOffset;
              out += `f ${a} ${b} ${c}\n`;
            }
          } else {
            for (let i = 0; i < posAttr.count; i += 3) {
              const a = vOffset + i + 0;
              const b = vOffset + i + 1;
              const c = vOffset + i + 2;
              out += `f ${a} ${b} ${c}\n`;
            }
          }

          vOffset += posAttr.count;
          out += "\n";
        }

        respond({ ok: true, objText: out });
      } catch (e) {
        respond({ ok: false, error: String(e?.message || e) });
      }
    };

    window.addEventListener("grasshopper:request-obj", onReqObj);
    return () => window.removeEventListener("grasshopper:request-obj", onReqObj);
  }, []);

  const finishCurrentPolyline = () => {
    const current = drawStateRef.current.current;
    if (current.length < 2) return;
    const lenM = computePolylineLengthMeters(current);
    drawStateRef.current.polylines.push(current.map((p) => p.clone()));
    drawStateRef.current.current = [];

    if (currentLineRef.current && drawGroupRef.current) {
      // Make it a "final" line
      const finalLine = currentLineRef.current;
      currentLineRef.current = null;
      try {
        finalLine.material = new THREE.LineBasicMaterial({ color: 0x60a5fa, linewidth: 2 });
      } catch {
        // ignore
      }
    }
    if (previewLineRef.current && drawGroupRef.current) {
      drawGroupRef.current.remove(previewLineRef.current);
      previewLineRef.current.geometry?.dispose?.();
      previewLineRef.current = null;
    }
    setModelStatus(`Draw: polyline saved (${lenM.toFixed(2)} m)`);
    forceUiUpdate((x) => x + 1);
  };

  const undoDraw = () => {
    const current = drawStateRef.current.current;
    if (current.length > 0) {
      current.pop();
      forceUiUpdate((x) => x + 1);
      return;
    }

    const lines = drawStateRef.current.polylines;
    if (!lines.length || !drawGroupRef.current) return;

    // Remove last finalized line object from the scene
    const last = drawGroupRef.current.children
      .slice()
      .reverse()
      .find((c) => c && c.type === "Line");
    if (last) {
      drawGroupRef.current.remove(last);
      last.geometry?.dispose?.();
      if (last.material) {
        const mats = Array.isArray(last.material) ? last.material : [last.material];
        for (const m of mats) m.dispose?.();
      }
    }
    lines.pop();
    forceUiUpdate((x) => x + 1);
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
    forceUiUpdate((x) => x + 1);
  };

  const sendDrawingsToGrasshopper = () => {
    const rhino = rhinoRef.current;
    if (!rhino) {
      setModelStatus("Rhino3dm not ready (cannot send curves)");
      return;
    }

    const GH_UNIT_SCALE = 1;

    const makePoint3d = (x, y, z) => {
      const P = rhino?.Point3d;
      if (!P) return null;

      // Attempt A: constructor
      try {
        if (typeof P === "function") return new P(x, y, z);
      } catch {
        // ignore
      }

      // Attempt B: callable factory
      try {
        if (typeof P === "function") return P(x, y, z);
      } catch {
        // ignore
      }

      // Attempt C: static create / fromArray
      try {
        if (typeof P.create === "function") return P.create(x, y, z);
      } catch {
        // ignore
      }
      try {
        if (typeof P.fromArray === "function") return P.fromArray([x, y, z]);
      } catch {
        // ignore
      }
      return null;
    };

    try {
      if (!sendDrawingsToGrasshopper._loggedApis) {
        sendDrawingsToGrasshopper._loggedApis = true;
        console.log("[GH] rhino curve APIs", {
          hasPoint3d: typeof rhino?.Point3d === "function",
          polylineAddType: typeof rhino?.Polyline?.prototype?.add,
          hasPolylineCurveCreateFromPoints: typeof rhino?.PolylineCurve?.createFromPoints === "function",
          hasNurbsCurveCreate: typeof rhino?.NurbsCurve?.create === "function",
          hasCurveCreateControlPointCurve: typeof rhino?.Curve?.createControlPointCurve === "function",
          hasNurbsCurveCreateControlPointCurve: typeof rhino?.NurbsCurve?.createControlPointCurve === "function",
          hasLineCurve: typeof rhino?.LineCurve === "function",
          hasLine: typeof rhino?.Line === "function",
          hasCommonObjectEncode: typeof rhino?.CommonObject?.encode === "function",
          nurbsCurveCreateArity: typeof rhino?.NurbsCurve?.create === "function" ? rhino.NurbsCurve.create.length : null,
          curveCreateControlPointCurveArity:
            typeof rhino?.Curve?.createControlPointCurve === "function" ? rhino.Curve.createControlPointCurve.length : null,
        });
      }
    } catch {
      // ignore
    }

    const all = [...drawStateRef.current.polylines];
    if (drawStateRef.current.current.length >= 2) {
      all.push(drawStateRef.current.current.map((p) => p.clone()));
    }
    if (!all.length) return;

    try {
      const lens = all.map((pts) => (pts && typeof pts.length === "number" ? pts.length : null));
      console.log("[GH] curve candidates", {
        lines: all.length,
        lengths: lens,
      });
    } catch {
      // ignore
    }

    const items = [];
    for (const pts of all) {
      if (!pts || pts.length < 2) continue;

      // Prefer createFromPoints / Point3dList when available.
      let crv = null;
      let builtVia = null;
      try {
        const ptsCoords = pts.map((pp) => ({ x: pp.x * GH_UNIT_SCALE, y: -pp.z * GH_UNIT_SCALE, z: pp.y * GH_UNIT_SCALE }));

        const ptsRhino = [];
        for (const c of ptsCoords) {
          const p3 = makePoint3d(c.x, c.y, c.z);
          if (!p3) {
            ptsRhino.length = 0;
            break;
          }
          ptsRhino.push(p3);
        }
        const hasPtsRhino = ptsRhino.length === ptsCoords.length;

        // Special case: 2 points => LineCurve
        if (!crv && ptsCoords && ptsCoords.length === 2) {
          try {
            const c0 = ptsCoords[0];
            const c1 = ptsCoords[1];
            if (typeof rhino?.LineCurve === "function") {
              // Different builds expose different ctor signatures. Try a few.
              const attempts = [];
              // Most common: LineCurve(Point3d, Point3d)
              if (hasPtsRhino && ptsRhino.length === 2) {
                const a = ptsRhino[0];
                const b = ptsRhino[1];
                attempts.push(() => new rhino.LineCurve(a, b));

                if (typeof rhino?.Line === "function") {
                  // Also common: LineCurve(Line)
                  attempts.push(() => new rhino.LineCurve(new rhino.Line(a, b)));
                }
              }

              for (const fn of attempts) {
                try {
                  const candidate = fn();
                  if (candidate) {
                    crv = candidate;
                    builtVia = "LineCurve";
                    break;
                  }
                } catch (e) {
                  console.warn(
                    `[GH] LineCurve ctor attempt failed: ${String(e?.name || "Error")}: ${String(e?.message || e)}`
                  );
                }
              }
            } else if (typeof rhino?.Line === "function") {
              // As a last resort, return a Line (some schemas accept it as geometry).
              try {
                const a = makePoint3d(c0.x, c0.y, c0.z);
                const b = makePoint3d(c1.x, c1.y, c1.z);
                const ln = a && b ? new rhino.Line(a, b) : null;
                if (ln) {
                  crv = ln;
                  builtVia = "Line";
                }
              } catch {
                // ignore
              }
            }
          } catch (e) {
            console.warn("[GH] LineCurve construction failed", {
              error: e,
              name: e?.name,
              message: String(e?.message || e),
              stack: e?.stack,
            });
          }
        }

        // Option 0: Curve.createControlPointCurve(points, degree)
        if (!crv && hasPtsRhino && ptsRhino.length >= 3 && typeof rhino?.Curve?.createControlPointCurve === "function") {
          try {
            const fn = rhino.Curve.createControlPointCurve;
            const arity = fn.length;
            if (arity <= 1) crv = fn(ptsRhino);
            else crv = fn(ptsRhino, 1);
            if (crv) builtVia = "Curve.createControlPointCurve";
            else {
              console.warn("[GH] Curve.createControlPointCurve returned null", { pts: ptsRhino.length, arity });
            }
          } catch (e) {
            console.warn("[GH] Curve.createControlPointCurve failed", { error: e, message: String(e?.message || e) });
          }
        }

        // Option 1: NurbsCurve.createControlPointCurve(points, degree)
        if (!crv && ptsRhino && typeof rhino?.NurbsCurve?.createControlPointCurve === "function") {
          try {
            crv = rhino.NurbsCurve.createControlPointCurve(ptsRhino, 1);
          } catch (e) {
            console.warn("[GH] NurbsCurve.createControlPointCurve failed", { error: e, message: String(e?.message || e) });
          }
        }

        // Option 2: NurbsCurve.create(...) (arity differs by build)
        const nurbsCreate = rhino?.NurbsCurve?.create;
        if (!crv && hasPtsRhino && typeof nurbsCreate === "function") {
          const attempts = [];
          const arity = nurbsCreate.length;
          // Common guesses across builds
          attempts.push([false, 1, ptsRhino]);
          attempts.push([false, 1, ptsRhino.length, ptsRhino]);
          attempts.push([3, false, 1, ptsRhino]);
          attempts.push([3, false, 2, ptsRhino.length, ptsRhino]);

          for (const args of attempts) {
            try {
              const nc = nurbsCreate(...args);
              if (nc) {
                crv = nc;
                builtVia = "NurbsCurve.create";
                break;
              }
            } catch (e) {
              console.warn("[GH] NurbsCurve.create failed", {
                message: String(e?.message || e),
                arity,
                argsLen: args.length,
              });
            }
          }
          if (!crv) {
            console.warn("[GH] NurbsCurve.create returned null", { pts: ptsRhino.length, arity });
          }
        }

        const createFromPoints = rhino?.PolylineCurve?.createFromPoints;
        if (!crv && hasPtsRhino && typeof createFromPoints === "function") {
          try {
            crv = createFromPoints(ptsRhino);
          } catch (e) {
            console.warn("[GH] PolylineCurve.createFromPoints failed", { error: e, message: String(e?.message || e) });
          }
        }

        if (!crv) {
          const poly = new rhino.Polyline();
          for (const p of pts) {
            // Three.js is Y-up. Rhino is Z-up.
            // Viewer shows Rhino geometry with a -90deg X rotation, so convert back when sending to GH.
            // Map (x, y, z) -> (x, z, y).
            try {
              // Prefer numeric add to avoid Point3d construction issues.
              poly.add(p.x * GH_UNIT_SCALE, -p.z * GH_UNIT_SCALE, p.y * GH_UNIT_SCALE);
            } catch (e) {
              console.warn("[GH] polyline point add failed", {
                error: e,
                message: String(e?.message || e),
                hasPoint3d: typeof rhino?.Point3d === "function",
                point: { x: p?.x, y: p?.y, z: p?.z },
              });
            }
          }

          try {
            const polyCountRaw =
              typeof poly?.count === "function" ? poly.count() : (poly?.count ?? poly?.Count);
            if (typeof polyCountRaw === "number" && polyCountRaw < 2) {
              console.warn("[GH] polyline has insufficient points after add", { polyCount: polyCountRaw, pts: pts.length });
              continue;
            }
          } catch {
            // ignore
          }

          crv = new rhino.PolylineCurve(poly);
        }
      } catch (e) {
        console.warn(
          `[GH] curve construction failed: ${String(e?.name || "Error")}: ${String(e?.message || e)} (pts=${pts?.length})`
        );
        crv = null;
      }

      if (!crv) {
        console.warn("[GH] curve construction produced null", { pts: pts?.length, builtVia });
        continue;
      }

      try {
        console.log("[GH] curve constructed", {
          pts: pts?.length,
          builtVia,
          className: crv?.constructor?.name,
          hasToJSON: typeof crv?.toJSON === "function",
        });
      } catch {
        // ignore
      }

      let data = null;
      try {
        if (typeof rhino?.CommonObject?.encode === "function") {
          const json = rhino.CommonObject.encode(crv);
          data = typeof json === "string" ? json : JSON.stringify(json);
        } else if (typeof crv?.toJSON === "function") {
          let json;
          // Some rhino3dm builds expose toJSON expecting the object as an argument.
          if (crv.toJSON.length >= 1) json = crv.toJSON(crv);
          else json = crv.toJSON();
          data = typeof json === "string" ? json : JSON.stringify(json);
        } else if (typeof rhino?.CommonObject?.toJSON === "function") {
          const json = rhino.CommonObject.toJSON(crv);
          data = typeof json === "string" ? json : JSON.stringify(json);
        } else {
          console.warn("[GH] curve has no serializer (encode/toJSON)", {
            className: crv?.constructor?.name,
          });
        }
      } catch (e) {
        data = null;
        console.warn("[GH] curve serialization failed", {
          message: String(e?.message || e),
          pts: pts?.length,
          hasToJSON: typeof crv?.toJSON === "function",
          hasEncode: typeof rhino?.CommonObject?.encode === "function",
        });

        // Second chance: try CommonObject.toJSON(crv)
        try {
          if (!data && typeof rhino?.CommonObject?.toJSON === "function") {
            const json = rhino.CommonObject.toJSON(crv);
            data = typeof json === "string" ? json : JSON.stringify(json);
          }
        } catch {
          // ignore
        }
      }

      if (!data) {
        console.warn("[GH] curve serialization produced no data", {
          pts: pts?.length,
          hasToJSON: typeof crv?.toJSON === "function",
          hasEncode: typeof rhino?.CommonObject?.encode === "function",
        });
        continue;
      }

      const className = crv?.constructor?.name || "";
      let itemType = "Rhino.Geometry.Curve";
      if (className === "PolylineCurve") itemType = "Rhino.Geometry.PolylineCurve";
      else if (className === "NurbsCurve") itemType = "Rhino.Geometry.NurbsCurve";
      items.push({ type: itemType, data });
    }

    if (!items.length) {
      console.warn("[GH] no curve items produced", {
        polylines: drawStateRef.current.polylines.length,
        currentPts: drawStateRef.current.current.length,
        allCandidateLines: all.length,
      });
      return;
    }
    window.dispatchEvent(new CustomEvent("grasshopper:input-curves", { detail: { paramName: "cr", items } }));
    return items;
  };

  useEffect(() => {
    const onRequestCurves = (ev) => {
      const requestId = ev?.detail?.requestId;
      console.log("[GH] viewer curve request", {
        requestId,
        rhinoReady: !!rhinoRef.current,
        polylines: drawStateRef.current.polylines.length,
        currentPts: drawStateRef.current.current.length,
      });

      if (!rhinoRef.current) {
        // Queue only the latest request id; GH panel will wait a bit longer.
        pendingCurveRequestIdRef.current = requestId;
        if (!pendingCurveRequestTimerRef.current) {
          pendingCurveRequestTimerRef.current = window.setTimeout(() => {
            pendingCurveRequestTimerRef.current = 0;
            if (pendingCurveRequestIdRef.current) {
              console.warn("[GH] curve request timed out waiting for rhino3dm", {
                requestId: pendingCurveRequestIdRef.current,
              });
              pendingCurveRequestIdRef.current = null;
            }
          }, 4000);
        }
        return;
      }

      const items = sendDrawingsToGrasshopper() || [];
      console.log("[GH] viewer curve response", { requestId, count: items.length });
      window.dispatchEvent(
        new CustomEvent("grasshopper:curves-response", {
          detail: { requestId, paramName: "cr", items },
        })
      );
    };

    window.addEventListener("grasshopper:request-curves", onRequestCurves);
    return () => window.removeEventListener("grasshopper:request-curves", onRequestCurves);
  }, []);

  const addGhOverlay = (schema) => {
    if (!sceneRef.current) return;
    const rhino = rhinoRef.current;
    if (!rhino) {
      pendingGhSchemaRef.current = schema;
      setModelStatus("Waiting for Rhino3dm to render GH result...");
      return;
    }

    console.log("[GH] overlay pipeline v2");

    const scene = sceneRef.current;
    if (ghGroupRef.current) {
      scene.remove(ghGroupRef.current);
      clearGroup(ghGroupRef.current);
      ghGroupRef.current = null;
    }

    const values = schema?.values;
    if (!Array.isArray(values)) {
      console.warn("[GH] schema.values missing or not an array", schema);
      return;
    }

    try {
      const outSummary = values.map((v) => {
        const inner = v?.InnerTree || v?.innerTree;
        const branchKeys = inner && typeof inner === "object" ? Object.keys(inner) : [];
        let itemCount = 0;
        const typeCounts = {};
        if (inner && typeof inner === "object") {
          for (const k of branchKeys) {
            const arr = inner[k];
            if (!Array.isArray(arr)) continue;
            itemCount += arr.length;
            for (const it of arr) {
              const t = String(it?.type || "<missing>");
              typeCounts[t] = (typeCounts[t] || 0) + 1;
            }
          }
        }
        return {
          ParamName: v?.ParamName,
          branches: branchKeys.length,
          itemCount,
          typeCounts,
        };
      });
      console.log("[GH] output trees", outSummary);
    } catch {
      // ignore
    }

    const overlay = new THREE.Group();
    overlay.name = "grasshopper-overlay";

    // Rhino is Z-up; Three.js is Y-up. Rotate so Rhino Z becomes Three Y.
    overlay.rotation.x = -Math.PI / 2;

    // Rhino/GH runs in mm; the city/drawing space is treated as meters in the viewer.
    // Scale the overlay back down to match the viewer.
    overlay.scale.setScalar(1);

    const mat = new THREE.MeshStandardMaterial({ color: 0xff7a00, metalness: 0.1, roughness: 0.7 });

    let decodedCount = 0;
    let meshCount = 0;
    let triCount = 0;

    const classCounts = new Map();

    const hasDecodeFn = typeof rhino?.CommonObject?.decode === "function";
    const hasFromJsonFn = typeof rhino?.CommonObject?.fromJSON === "function" || typeof rhino?.CommonObject?.FromJSON === "function";
    if (!hasDecodeFn && hasFromJsonFn) {
      console.warn("[GH] rhino.CommonObject.decode is not a function; will try CommonObject.fromJSON fallback");
    } else if (!hasDecodeFn && !hasFromJsonFn) {
      console.warn("[GH] no rhino CommonObject decoder available (decode/fromJSON)");
    }

    let decodeFailCount = 0;
    let skippedItemCount = 0;

    const getMeshingParams = () => {
      try {
        const mp = rhino.MeshingParameters;
        if (!mp) return null;

        if (mp.default) return mp.default;
        if (mp.defaultParameters) return mp.defaultParameters;
        if (typeof mp.createDefault === "function") return mp.createDefault();
        if (typeof mp.defaultObject === "function") return mp.defaultObject();
      } catch {
        // ignore
      }
      return null;
    };

    let warnedNoCreateFromBrep = false;

    const normalizeMeshList = (res) => {
      if (!res) return [];
      if (Array.isArray(res)) return res;
      if (typeof res.count === "number" && typeof res.get === "function") {
        const out = [];
        for (let i = 0; i < res.count; i++) out.push(res.get(i));
        return out;
      }
      if (typeof res.length === "number") return Array.from(res);
      return [];
    };

    const getRenderMeshType = () => {
      const mt = rhino?.MeshType;
      if (!mt) return 0;
      return mt.Render ?? mt.render ?? mt.Analysis ?? mt.analysis ?? 0;
    };

    const tryMeshFromBrep = (brep) => {
      if (!brep) return [];

      const mp = getMeshingParams();
      const meshType = getRenderMeshType();

      // Option A: static Mesh.createFromBrep (not available in some browser builds)
      try {
        const fn = rhino?.Mesh?.createFromBrep;
        if (typeof fn === "function") {
          const res = mp ? fn(brep, mp) : fn(brep);
          const meshes = normalizeMeshList(res);
          if (meshes.length) return meshes;
        } else if (!warnedNoCreateFromBrep) {
          warnedNoCreateFromBrep = true;
          console.warn("[GH] rhino.Mesh.createFromBrep is not a function");
        }
      } catch (err) {
        console.warn("[GH] createFromBrep failed", err);
      }

      // Option B: Brep.getMeshes(meshType)
      try {
        if (typeof brep.getMeshes === "function") {
          const res = brep.getMeshes(meshType);
          const meshes = normalizeMeshList(res);
          if (meshes.length) return meshes;
        }
      } catch {
        // ignore
      }

      // Option C: BrepFace.getMesh(meshType) for each face
      try {
        if (typeof brep.faces === "function") {
          const faces = brep.faces();
          const out = [];
          if (faces && typeof faces.count === "number" && typeof faces.get === "function") {
            for (let i = 0; i < faces.count; i++) {
              const face = faces.get(i);
              if (!face) continue;
              if (typeof face.getMesh === "function") {
                const m = face.getMesh(meshType);
                const meshes = normalizeMeshList(m);
                for (const mm of meshes) out.push(mm);
              }
            }
          }
          if (out.length) return out;
        }
      } catch {
        // ignore
      }

      // Option D: Brep.createMesh / getMesh (less common)
      try {
        if (typeof brep.createMesh === "function") {
          const res = mp ? brep.createMesh(mp) : brep.createMesh();
          const meshes = normalizeMeshList(res);
          if (meshes.length) return meshes;
        }
      } catch {
        // ignore
      }

      try {
        if (typeof brep.getMesh === "function") {
          const res = brep.getMesh(meshType);
          const meshes = normalizeMeshList(res);
          if (meshes.length) return meshes;
        }
      } catch {
        // ignore
      }

      return [];
    };

    const tryGetMeshes = (obj, typeStr) => {
      if (!obj) return [];
      try {
        if (obj instanceof rhino.Mesh) return [obj];
      } catch {
        // ignore
      }

      try {
        if (obj instanceof rhino.Brep) return tryMeshFromBrep(obj);
      } catch {
        // ignore
      }

      // Some types come back as Extrusion/Surface/other classes; try converting to Brep.
      try {
        if (typeof obj.toBrep === "function") {
          const brep = obj.toBrep();
          const meshes = tryMeshFromBrep(brep);
          if (meshes.length) return meshes;
        }
      } catch {
        // ignore
      }

      try {
        if (typeof obj.brepForm === "function") {
          const brep = obj.brepForm();
          const meshes = tryMeshFromBrep(brep);
          if (meshes.length) return meshes;
        }
      } catch {
        // ignore
      }

      // As a last resort, if the declared type says Brep, try meshing anyway.
      const t = String(typeStr || "").toLowerCase();
      if (t.includes("brep")) {
        return tryMeshFromBrep(obj);
      }

      return [];
    };

    const vertexToXYZ = (v) => {
      if (!v) return [0, 0, 0];
      if (Array.isArray(v)) return [v[0], v[1], v[2]];
      if (typeof v === "object") {
        const x = v.x ?? v.X ?? v[0] ?? 0;
        const y = v.y ?? v.Y ?? v[1] ?? 0;
        const z = v.z ?? v.Z ?? v[2] ?? 0;
        return [x, y, z];
      }
      return [0, 0, 0];
    };

    const faceToIndices = (f) => {
      if (!f) return null;
      if (Array.isArray(f)) {
        const a = f[0];
        const b = f[1];
        const c = f[2];
        const d = f[3];
        return { a, b, c, d };
      }
      if (typeof f === "object") {
        const a = f.a ?? f.A ?? f[0];
        const b = f.b ?? f.B ?? f[1];
        const c = f.c ?? f.C ?? f[2];
        const d = f.d ?? f.D ?? f[3];
        return { a, b, c, d };
      }
      return null;
    };

    for (const tree of values) {
      const inner = tree?.InnerTree || tree?.innerTree;
      if (!inner || typeof inner !== "object") continue;

      for (const branchKey of Object.keys(inner)) {
        const items = inner[branchKey];
        if (!Array.isArray(items)) continue;

        for (const item of items) {
          // Resthopper can vary in casing/shape depending on source.
          const type = item?.type ?? item?.Type;
          const data = item?.data ?? item?.Data;
          if (!type || data == null) {
            skippedItemCount += 1;
            if (skippedItemCount <= 5) {
              let keys = [];
              try {
                keys = item && typeof item === "object" ? Object.keys(item) : [];
              } catch {
                keys = [];
              }
              console.warn("[GH] output item missing type/data; skipped", {
                ParamName: tree?.ParamName,
                branchKey,
                keys,
                item,
              });
            }
            continue;
          }

          let json = data;
          if (typeof json === "string") {
            try {
              json = JSON.parse(json);
            } catch {
              // leave as string
            }
          }

          let obj;
          try {
            if (typeof rhino?.CommonObject?.decode === "function") {
              obj = rhino.CommonObject.decode(json);
            } else if (typeof rhino?.CommonObject?.fromJSON === "function") {
              obj = rhino.CommonObject.fromJSON(json);
            } else if (typeof rhino?.CommonObject?.FromJSON === "function") {
              obj = rhino.CommonObject.FromJSON(json);
            } else {
              obj = null;
            }
          } catch (e) {
            obj = null;
            decodeFailCount += 1;
            if (decodeFailCount <= 5) {
              let snippet = null;
              try {
                snippet = typeof data === "string" ? data.slice(0, 160) : JSON.stringify(data).slice(0, 160);
              } catch {
                snippet = "<unavailable>";
              }
              console.warn("[GH] decode failed", {
                ParamName: tree?.ParamName,
                type,
                message: String(e?.message || e),
                dataSnippet: snippet,
              });
            }
          }
          if (!obj) continue;

          decodedCount += 1;

          const className = obj?.constructor?.name || "<unknown>";
          classCounts.set(className, (classCounts.get(className) || 0) + 1);

          const meshes = tryGetMeshes(obj, type);

          for (const m of meshes || []) {
            try {
              meshCount += 1;
              const geo = new THREE.BufferGeometry();

              const verts = m.vertices();
              const vCount = verts.count;
              const pos = new Float32Array(vCount * 3);
              for (let i = 0; i < vCount; i++) {
                const v = verts.get(i);
                const xyz = vertexToXYZ(v);
                pos[i * 3 + 0] = xyz[0];
                pos[i * 3 + 1] = xyz[1];
                pos[i * 3 + 2] = xyz[2];
              }
              geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

              const faces = m.faces();
              const fCount = faces.count;
              const indices = [];
              for (let fi = 0; fi < fCount; fi++) {
                const raw = faces.get(fi);
                const f = faceToIndices(raw);
                if (!f) continue;
                const a = f.a;
                const b = f.b;
                const c = f.c;
                const d = f.d;
                if (d === undefined || d === null || d === c) {
                  indices.push(a, b, c);
                  triCount += 1;
                } else {
                  indices.push(a, b, c);
                  indices.push(a, c, d);
                  triCount += 2;
                }
              }
              geo.setIndex(indices);
              geo.computeVertexNormals();

              const mesh = new THREE.Mesh(geo, mat);
              overlay.add(mesh);
            } catch (err) {
              console.warn("[GH] mesh conversion failed", err);
            }
          }
        }
      }
    }

    const decodedClasses = Object.fromEntries(classCounts);
    console.log("[GH] decode summary", {
      decodedCount,
      meshCount,
      triCount,
      outputs: values.length,
      classes: decodedClasses,
    });
    console.log("[GH] decoded classes", decodedClasses);
    if (overlay.children.length < 1) {
      console.warn("[GH] no meshes produced from solve output", {
        decodedCount,
        meshCount,
        triCount,
      });
      return;
    }

    // Keep overlay in the same coordinate space as the input curves.
    // Do not auto-center/shift relative to the city bbox, otherwise the result will not
    // align with the drawn lines that were sent to Grasshopper.
    const bb = new THREE.Box3().setFromObject(overlay);
    const overlaySize = bb.getSize(new THREE.Vector3());

    scene.add(overlay);
    ghGroupRef.current = overlay;

    const cityGroups = groupsRef.current;
    const cityCandidates = [cityGroups?.buildings, cityGroups?.roads, cityGroups?.parks, cityGroups?.water].filter(Boolean);

    const maxDim = Math.max(overlaySize.x, overlaySize.y, overlaySize.z);
    const dist = maxDim * 1.8 || 20;
    if (cameraRef.current && !cityCandidates.length) {
      cameraRef.current.position.set(dist, dist, dist);
      targetRef.current.set(0, 0, 0);
      cameraRef.current.lookAt(targetRef.current);
    }
  };

  async function renderBbox(bbox) {
    const seq = (osmRenderSeqRef.current += 1);
    try {
      osmAbortRef.current?.abort?.();
    } catch {
      // ignore
    }
    osmAbortRef.current = null;

    console.log("[OSM] renderBbox called", {
      bbox,
      hasScene: !!sceneRef.current,
      hasCamera: !!cameraRef.current,
      hasRenderer: !!rendererRef.current,
    });
    if (!sceneRef.current || !cameraRef.current) {
      console.warn("[OSM] renderBbox: scene/camera not ready", {
        hasScene: !!sceneRef.current,
        hasCamera: !!cameraRef.current,
        hasRenderer: !!rendererRef.current,
      });
      return;
    }

    setBaseModelReady(false);
    if (drawModeRef.current) {
      setDrawMode(false);
    }
    setModelStatus("Loading OSM...");

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

    let geojson = null;
    try {
      console.log("[OSM] fetch /api/osm start", { west, south, east, north });
      const controller = new AbortController();
      osmAbortRef.current = controller;
      const timeoutId = window.setTimeout(() => controller.abort(), 30000);
      const res = await fetch("/api/osm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox: [west, south, east, north] }),
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);

      if (seq !== osmRenderSeqRef.current) return;

      console.log("[OSM] fetch /api/osm response", { ok: res.ok, status: res.status });

      if (!res.ok) {
        let msg = "";
        try {
          msg = await res.text();
        } catch {
          msg = "";
        }
        console.warn("[OSM] fetch /api/osm not ok", { status: res.status, msg: msg?.slice?.(0, 200) });
        setModelStatus(`OSM request failed (${res.status})${msg ? ": " + msg.slice(0, 140) : ""}`);
        return;
      }

      try {
        geojson = await res.json();
        if (seq !== osmRenderSeqRef.current) return;
        console.log("[OSM] fetch /api/osm parsed json", {
          type: geojson?.type,
          features: Array.isArray(geojson?.features) ? geojson.features.length : null,
        });
      } catch (e) {
        setModelStatus(`OSM response parse error: ${String(e?.message || e)}`);
        return;
      }
    } catch (e) {
      const name = String(e?.name || "");
      const msg = String(e?.message || e);
      const isAbort = name === "AbortError" || msg.toLowerCase().includes("aborted") || msg.toLowerCase().includes("abort");
      if (isAbort) {
        // Expected when switching bbox quickly or when a new render starts.
        return;
      }

      console.warn("[OSM] fetch /api/osm failed", e);
      if (seq === osmRenderSeqRef.current) setModelStatus(`OSM request error: ${msg}`);
      return;
    } finally {
      if (osmAbortRef.current && osmAbortRef.current.signal?.aborted) {
        // keep for debugging
      }
      if (seq === osmRenderSeqRef.current) {
        osmAbortRef.current = null;
      }
    }

    try {
      const allFeatures = geojson.features || [];
      console.log("[OSM] features", allFeatures.length);
      if (!allFeatures.length) {
        setModelStatus("No OSM features in this area");
        return;
      }

      const buildings = allFeatures.filter((f) => {
        const props = f.properties || {};
        return props.building || props["building:part"] || props["building:use"];
      });
      console.log("[OSM] buildings", buildings.length);
      if (!buildings.length) {
        setModelStatus("No buildings found (rendering other OSM layers if available)...");
      } else {
        setModelStatus(`OSM OK: ${buildings.length} buildings`);
      }

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

      // Convert lon/lat to local meters (approx). This preserves aspect ratio and prevents
      // buildings looking unnaturally stretched.
      const metersPerDegLat = 111320;
      const metersPerDegLon = 111320 * Math.cos((cy * Math.PI) / 180);

      const projectPoint = (lon, lat) => {
        const x = (lon - cx) * metersPerDegLon;
        const y = (lat - cy) * metersPerDegLat;
        return new THREE.Vector3(x, y, 0);
      };

      const allPoints = [
        projectPoint(west, south),
        projectPoint(west, north),
        projectPoint(east, south),
        projectPoint(east, north),
      ];

      for (const f of featuresWithHeight) {
      const geom = f.geometry;
      if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue;

      const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      for (const poly of polygons) {
        const ring = poly[0];
        if (!ring || ring.length < 3) continue;

        const shapePts = [];
        for (const [lon, lat] of ring) {
          const p = projectPoint(lon, lat);
          shapePts.push(new THREE.Vector2(p.x, p.y));
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

        // OSM building heights are typically in meters. Use them directly (with a reasonable clamp)
        // so the city doesn't look like needles.
        const height = Math.min(200, Math.max(2, h));

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
            allPoints.push(pts[0]);
            allPoints.push(pts[pts.length - 1]);
          }
        } else if (geom.type === "MultiLineString") {
          for (const lineCoords of geom.coordinates) {
            const pts = lineCoords.map(([lon, lat]) => projectPoint(lon, lat));
            if (pts.length < 2) continue;
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            geo.rotateX(-Math.PI / 2);
            const mat = new THREE.LineBasicMaterial({ color: 0xaaaaaa });
            roadsGroup.add(new THREE.Line(geo, mat));
            allPoints.push(pts[0]);
            allPoints.push(pts[pts.length - 1]);
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
          const p = projectPoint(lon, lat);
          shapePts.push(new THREE.Vector2(p.x, p.y));
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

        if (shapePts.length) {
          allPoints.push(new THREE.Vector3(shapePts[0].x, shapePts[0].y, 0));
        }
      }
    }

      const hasAnyGeometry =
        buildingsGroup.children.length > 0 ||
        roadsGroup.children.length > 0 ||
        parksGroup.children.length > 0 ||
        waterGroup.children.length > 0;

      if (!hasAnyGeometry) {
        setModelStatus("No OSM geometry to render in this area");
        return;
      }

      if (seq !== osmRenderSeqRef.current) return;

      // Compute bbox in *final* scene coordinates (after geometry rotations), otherwise
      // the city may float above/below the grid due to mixed coordinate spaces.
      const combined = new THREE.Group();
      combined.add(buildingsGroup);
      combined.add(roadsGroup);
      combined.add(parksGroup);
      combined.add(waterGroup);

      combined.updateMatrixWorld(true);

      const overallBB = new THREE.Box3().setFromObject(combined);
      const center = overallBB.getCenter(new THREE.Vector3());
      const size = overallBB.getSize(new THREE.Vector3());

      const offset = new THREE.Vector3(center.x, overallBB.min.y, center.z);
      buildingsGroup.position.sub(offset);
      roadsGroup.position.sub(offset);
      parksGroup.position.sub(offset);
      waterGroup.position.sub(offset);

      // Secondary correction: ensure the final minY is exactly at ground level.
      combined.updateMatrixWorld(true);
      const bb2 = new THREE.Box3().setFromObject(combined);
      if (Number.isFinite(bb2.min.y) && Math.abs(bb2.min.y) > 1e-6) {
        const dy = bb2.min.y;
        buildingsGroup.position.y -= dy;
        roadsGroup.position.y -= dy;
        parksGroup.position.y -= dy;
        waterGroup.position.y -= dy;
      }

      if (seq !== osmRenderSeqRef.current) {
        clearGroup(buildingsGroup);
        clearGroup(roadsGroup);
        clearGroup(parksGroup);
        clearGroup(waterGroup);
        return;
      }

      scene.add(roadsGroup);
      scene.add(parksGroup);
      scene.add(waterGroup);
      scene.add(buildingsGroup);

      groupsRef.current = { buildings: buildingsGroup, roads: roadsGroup, parks: parksGroup, water: waterGroup };
      setBaseModelReady(true);

      setModelStatus(
        `City model ready (buildings: ${buildingsGroup.children.length}, roads: ${roadsGroup.children.length}, parks: ${parksGroup.children.length}, water: ${waterGroup.children.length})`
      );

      const maxDim = Math.max(size.x, size.y, size.z);
      const dist = maxDim * 1.8 || 20;
      if (cameraRef.current) {
        // City is in meters and can span many kilometers; keep far plane large enough to avoid clipping.
        const nextFar = Math.max(cameraRef.current.far || 0, dist * 10, 50_000);
        if (nextFar !== cameraRef.current.far) {
          cameraRef.current.far = nextFar;
          cameraRef.current.updateProjectionMatrix();
        }
        cameraRef.current.position.set(dist, dist, dist);
        targetRef.current.set(0, 0, 0);
        cameraRef.current.lookAt(targetRef.current);
      }
    } catch (e) {
      console.error("[OSM] renderBbox processing failed", e);
      setModelStatus(`OSM render error: ${String(e?.message || e)}`);
      setBaseModelReady(false);
    }
  }

  useEffect(() => {
    const onGh = (ev) => {
      const schema = ev?.detail?.schema;
      const outCount = Array.isArray(schema?.values) ? schema.values.length : 0;
      console.log("[GH] viewer received", { outputs: outCount });
      addGhOverlay(schema);
    };

    window.addEventListener("grasshopper:result", onGh);
    return () => {
      window.removeEventListener("grasshopper:result", onGh);
      if (sceneRef.current && ghGroupRef.current) {
        sceneRef.current.remove(ghGroupRef.current);
        clearGroup(ghGroupRef.current);
        ghGroupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const onClear = () => {
      if (sceneRef.current && ghGroupRef.current) {
        sceneRef.current.remove(ghGroupRef.current);
        clearGroup(ghGroupRef.current);
        ghGroupRef.current = null;
      }
    };

    window.addEventListener("grasshopper:clear-result", onClear);
    return () => window.removeEventListener("grasshopper:clear-result", onClear);
  }, []);

  useEffect(() => {
    const handler = (event) => {
      const data = event?.data;
      if (!data || data.type !== "cadmapper:bbox" || !Array.isArray(data.bbox)) return;
      const bbox = data.bbox;
      if (bbox.length !== 4) return;
      console.log("[Map] bbox received", bbox);

      // New city input invalidates any previously computed Grasshopper overlay.
      try {
        pendingGhSchemaRef.current = null;
      } catch {
        // ignore
      }
      if (sceneRef.current && ghGroupRef.current) {
        sceneRef.current.remove(ghGroupRef.current);
        clearGroup(ghGroupRef.current);
        ghGroupRef.current = null;
      }

      if (!sceneRef.current || !cameraRef.current || !rendererRef.current) {
        pendingBboxRef.current = bbox;
        const canvas = canvasRef.current;
        let rect = null;
        try {
          rect = canvas?.getBoundingClientRect?.() || null;
        } catch {
          rect = null;
        }
        console.log("[OSM] bbox queued (viewer not ready)", {
          hasCanvas: !!canvas,
          rect: rect
            ? {
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                x: Math.round(rect.x),
                y: Math.round(rect.y),
              }
            : null,
        });
        setModelStatus((s) => {
          if (String(s || "").startsWith("Waiting for canvas size")) return s;
          return "Viewer not ready yet — bbox queued";
        });

        // Ensure we start the flush loop even if bbox arrives before init finishes.
        try {
          pendingBboxStartFlushRef.current?.();
        } catch {
          // ignore
        }
        return;
      }
      renderBbox(bbox);
    };

    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
    };
  }, []);

  const totalFinal = drawStateRef.current.polylines.length;
  const currentPts = drawStateRef.current.current.length;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 280 }}>
      {webglError ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            background: "rgba(0,0,0,0.65)",
            color: "rgba(230,240,255,0.95)",
            textAlign: "center",
          }}
        >
          <div style={{ maxWidth: 520, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>WebGL is not available</div>
            <div style={{ fontSize: 12, opacity: 0.9, lineHeight: 1.4 }}>
              The 3D viewer requires WebGL, but the browser could not create a WebGL context. This can happen if
              hardware acceleration is disabled, you are running in a restricted/sandboxed environment, or the GPU
              driver is unavailable.
            </div>
            <div style={{ fontSize: 11, opacity: 0.85, wordBreak: "break-word" }}>{webglError}</div>
          </div>
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          zIndex: 5,
          top: 10,
          left: 10,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          padding: 8,
          borderRadius: 10,
          background: "rgba(10, 18, 30, 0.65)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "rgba(230,240,255,0.95)",
          backdropFilter: "blur(6px)",
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (!baseModelReady) {
              setModelStatus("Load CadMapper model first: click Analyze on the map");
              return;
            }
            const next = !drawModeRef.current;
            drawModeRef.current = next;
            setDrawMode(next);
          }}
          disabled={!baseModelReady}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: drawMode ? "rgba(34,197,94,0.85)" : "rgba(17,24,39,0.8)",
            color: "#e5e7eb",
            cursor: baseModelReady ? "pointer" : "not-allowed",
            opacity: baseModelReady ? 1 : 0.55,
          }}
        >
          {drawMode ? "Draw: ON" : "Draw: OFF"}
        </button>

        <div style={{ fontSize: 12, opacity: 0.85 }}>
          City: {baseModelReady ? "ready" : "not loaded"}
        </div>

        <button
          type="button"
          onClick={finishCurrentPolyline}
          disabled={!baseModelReady || currentPts < 2}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(59,130,246,0.85)",
            color: "#e5e7eb",
            cursor: baseModelReady && currentPts >= 2 ? "pointer" : "not-allowed",
            opacity: baseModelReady && currentPts >= 2 ? 1 : 0.5,
          }}
        >
          Finish
        </button>

        <button
          type="button"
          onClick={undoDraw}
          disabled={!baseModelReady || (currentPts === 0 && totalFinal === 0)}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(17,24,39,0.8)",
            color: "#e5e7eb",
            cursor: baseModelReady && (currentPts > 0 || totalFinal > 0) ? "pointer" : "not-allowed",
            opacity: baseModelReady && (currentPts > 0 || totalFinal > 0) ? 1 : 0.5,
          }}
        >
          Undo
        </button>

        <button
          type="button"
          onClick={clearAllDrawings}
          disabled={!baseModelReady || (currentPts === 0 && totalFinal === 0)}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(239,68,68,0.85)",
            color: "#e5e7eb",
            cursor: baseModelReady && (currentPts > 0 || totalFinal > 0) ? "pointer" : "not-allowed",
            opacity: baseModelReady && (currentPts > 0 || totalFinal > 0) ? 1 : 0.5,
          }}
        >
          Clear
        </button>

        <div style={{ fontSize: 12, opacity: 0.85 }}>
          lines: {totalFinal} | points: {currentPts}
        </div>

        {modelStatus ? <div style={{ fontSize: 12, opacity: 0.9 }}>{modelStatus}</div> : null}
      </div>

      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          minHeight: 280,
          display: "block",
          background: "#000",
          cursor: drawMode ? "crosshair" : "grab",
        }}
      />
    </div>
  );
}

export default RhinoViewer;

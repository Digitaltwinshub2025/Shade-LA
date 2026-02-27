import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

class OBJParser {
  static parseOBJ(text) {
    const vertices = [];
    const faces = [];

    const lines = String(text || "").split("\n");

    for (const line of lines) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed || lineTrimmed.startsWith("#")) continue;

      const parts = lineTrimmed.split(/\s+/);
      const type = parts[0];

      switch (type) {
        case "v":
          vertices.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
          break;

        case "f": {
          const face = [];
          for (let i = 1; i < parts.length; i++) {
            const vertexIndex = parseInt(parts[i].split("/")[0], 10) - 1;
            face.push(vertexIndex);
          }

          for (let i = 1; i < face.length - 1; i++) {
            faces.push(face[0], face[i], face[i + 1]);
          }
          break;
        }

        default:
          break;
      }
    }

    return { vertices, faces };
  }

  static createGeometry(data) {
    const geometry = new THREE.BufferGeometry();

    const vertices = new Float32Array(data.vertices);
    const indices = new Uint32Array(data.faces);

    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    return geometry;
  }

  static getGeometryInfo(geometry) {
    const vertices = geometry.attributes.position.count;
    const faces = geometry.index.count / 3;
    const boundingBox = geometry.boundingBox;

    return {
      vertices,
      faces,
      bounds: {
        min: boundingBox.min,
        max: boundingBox.max,
        size: boundingBox.max.clone().sub(boundingBox.min),
        center: boundingBox.getCenter(new THREE.Vector3()),
      },
    };
  }
}

function GrasshopperRenderPanel() {
  const [status, setStatus] = useState("Waiting for GH result…");
  const [lastError, setLastError] = useState("");
  const [lastObjText, setLastObjText] = useState("");
  const [rotDeg, setRotDeg] = useState({ x: 0, y: 0, z: 0 });

  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const meshRef = useRef(null);
  const rafRef = useRef(0);
  const viewCenterRef = useRef(new THREE.Vector3(0, 0, 0));
  const viewDistRef = useRef(50);

  const requestObjFromViewer = useMemo(() => {
    return async () => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setStatus("Exporting OBJ…");
      setLastError("");

      return new Promise((resolve) => {
        let done = false;

        const cleanup = () => {
          window.removeEventListener("grasshopper:obj", onObj);
        };

        const onObj = (ev) => {
          const detail = ev?.detail;
          if (!detail || detail.requestId !== requestId) return;
          done = true;
          cleanup();

          if (detail.ok && typeof detail.objText === "string" && detail.objText.trim()) {
            resolve({ ok: true, objText: detail.objText });
            return;
          }

          const msg = detail?.error ? String(detail.error) : "OBJ export failed";
          resolve({ ok: false, error: msg });
        };

        window.addEventListener("grasshopper:obj", onObj);
        window.dispatchEvent(new CustomEvent("grasshopper:request-obj", { detail: { requestId } }));

        window.setTimeout(() => {
          if (done) return;
          cleanup();
          resolve({ ok: false, error: "OBJ export timeout (viewer did not respond)" });
        }, 3000);
      });
    };
  }, []);

  const renderObjToDataUrl = useMemo(() => {
    return (objText, width = 1280, height = 720) => {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1a1a1a);

      const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 10000);
      camera.position.set(100, 100, 100);

      const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
      scene.add(ambientLight);

      const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
      directionalLight.position.set(50, 100, 50);
      scene.add(directionalLight);

      const axesHelper = new THREE.AxesHelper(50);
      scene.add(axesHelper);

      const gridHelper = new THREE.GridHelper(500, 50, 0x444444, 0x222222);
      scene.add(gridHelper);

      const parsed = OBJParser.parseOBJ(objText);
      if (!parsed?.vertices?.length || !parsed?.faces?.length) {
        throw new Error("OBJ contains no vertices/faces");
      }
      const geometry = OBJParser.createGeometry(parsed);
      const info = OBJParser.getGeometryInfo(geometry);

      const mat = new THREE.MeshPhongMaterial({
        color: "#4CAF50",
        opacity: 1.0,
        transparent: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, mat);

      // Apply initial rotation to align axes (Z-up to Y-up)
      mesh.rotation.x = -Math.PI / 2;
      scene.add(mesh);

      // Use world-space bbox after rotation (and any future transforms) to fit camera.
      const worldBox = new THREE.Box3().setFromObject(mesh);
      const worldSize = worldBox.getSize(new THREE.Vector3());
      const worldCenter = worldBox.getCenter(new THREE.Vector3());

      const maxDim = Math.max(worldSize.x, worldSize.y, worldSize.z) || 1;
      const dist = maxDim * 2;
      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = Math.max(10000, maxDim * 20);
      camera.updateProjectionMatrix();
      camera.position.set(worldCenter.x + dist, worldCenter.y + dist, worldCenter.z + dist);
      camera.lookAt(worldCenter);

      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);

      const dataUrl = renderer.domElement.toDataURL("image/png");
      renderer.dispose?.();
      geometry.dispose?.();
      mat.dispose?.();

      return dataUrl;
    };
  }, []);

  const ensureInteractiveViewer = useMemo(() => {
    return () => {
      const mount = mountRef.current;
      if (!mount) return false;
      if (rendererRef.current && sceneRef.current && cameraRef.current && controlsRef.current) return true;

      const w = mount.clientWidth || 800;
      const h = mount.clientHeight || 500;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1a1a1a);

      const camera = new THREE.PerspectiveCamera(75, w / h, 0.1, 10000);
      camera.position.set(100, 100, 100);
      camera.up.set(0, 1, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(w, h, false);
      mount.innerHTML = "";
      mount.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.minPolarAngle = 0.05;
      controls.maxPolarAngle = Math.PI - 0.05;

      const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
      scene.add(ambientLight);

      const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
      directionalLight.position.set(50, 100, 50);
      scene.add(directionalLight);

      const axesHelper = new THREE.AxesHelper(50);
      scene.add(axesHelper);

      const gridHelper = new THREE.GridHelper(500, 50, 0x444444, 0x222222);
      scene.add(gridHelper);

      rendererRef.current = renderer;
      sceneRef.current = scene;
      cameraRef.current = camera;
      controlsRef.current = controls;

      const animate = () => {
        if (!rendererRef.current || !sceneRef.current || !cameraRef.current || !controlsRef.current) return;
        controlsRef.current.update();
        rendererRef.current.render(sceneRef.current, cameraRef.current);
        rafRef.current = requestAnimationFrame(animate);
      };
      rafRef.current = requestAnimationFrame(animate);

      return true;
    };
  }, []);

  const setObjInViewer = useMemo(() => {
    return (objText) => {
      const ok = ensureInteractiveViewer();
      if (!ok) return;

      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return;

      if (meshRef.current) {
        try {
          scene.remove(meshRef.current);
        } catch {
          // ignore
        }
        try {
          meshRef.current.geometry?.dispose?.();
        } catch {
          // ignore
        }
        try {
          meshRef.current.material?.dispose?.();
        } catch {
          // ignore
        }
        meshRef.current = null;
      }

      const parsed = OBJParser.parseOBJ(objText);
      if (!parsed?.vertices?.length || !parsed?.faces?.length) {
        throw new Error("OBJ contains no vertices/faces");
      }

      const geometry = OBJParser.createGeometry(parsed);

      const mat = new THREE.MeshPhongMaterial({
        color: "#4CAF50",
        opacity: 1.0,
        transparent: false,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geometry, mat);
      mesh.rotation.x = THREE.MathUtils.degToRad(rotDeg.x);
      mesh.rotation.y = THREE.MathUtils.degToRad(rotDeg.y);
      mesh.rotation.z = THREE.MathUtils.degToRad(rotDeg.z);
      scene.add(mesh);
      meshRef.current = mesh;

      const worldBox = new THREE.Box3().setFromObject(mesh);
      const worldSize = worldBox.getSize(new THREE.Vector3());
      const worldCenter = worldBox.getCenter(new THREE.Vector3());
      const maxDim = Math.max(worldSize.x, worldSize.y, worldSize.z) || 1;

      const dist = maxDim * 2;
      viewCenterRef.current.copy(worldCenter);
      viewDistRef.current = dist;
      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = Math.max(10000, maxDim * 20);
      camera.updateProjectionMatrix();
      camera.position.set(worldCenter.x + dist, worldCenter.y + dist, worldCenter.z + dist);
      controls.target.copy(worldCenter);
      controls.update();
    };
  }, [ensureInteractiveViewer, rotDeg.x, rotDeg.y, rotDeg.z]);

  const applyRotationToMesh = useMemo(() => {
    return (nextRotDeg) => {
      setRotDeg(nextRotDeg);
      const mesh = meshRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!mesh || !scene || !camera || !controls) return;

      mesh.rotation.x = THREE.MathUtils.degToRad(nextRotDeg.x);
      mesh.rotation.y = THREE.MathUtils.degToRad(nextRotDeg.y);
      mesh.rotation.z = THREE.MathUtils.degToRad(nextRotDeg.z);
      mesh.updateMatrixWorld(true);

      const worldBox = new THREE.Box3().setFromObject(mesh);
      const worldSize = worldBox.getSize(new THREE.Vector3());
      const worldCenter = worldBox.getCenter(new THREE.Vector3());
      const maxDim = Math.max(worldSize.x, worldSize.y, worldSize.z) || 1;
      const dist = maxDim * 2;
      viewCenterRef.current.copy(worldCenter);
      viewDistRef.current = dist;
      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = Math.max(10000, maxDim * 20);
      camera.updateProjectionMatrix();
      camera.position.set(worldCenter.x + dist, worldCenter.y + dist, worldCenter.z + dist);
      controls.target.copy(worldCenter);
      controls.update();
    };
  }, []);

  const centerAndGround = useMemo(() => {
    return () => {
      const mesh = meshRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!mesh || !camera || !controls) return;

      mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const minY = box.min.y;

      // Move model to origin in X/Z and onto the ground plane (minY = 0)
      mesh.position.x += -center.x;
      mesh.position.z += -center.z;
      mesh.position.y += -minY;
      mesh.updateMatrixWorld(true);

      const box2 = new THREE.Box3().setFromObject(mesh);
      const center2 = box2.getCenter(new THREE.Vector3());
      const size2 = box2.getSize(new THREE.Vector3());
      const maxDim = Math.max(size2.x, size2.y, size2.z) || 1;
      const dist = maxDim * 2;

      viewCenterRef.current.copy(center2);
      viewDistRef.current = dist;

      camera.near = Math.max(0.01, maxDim / 1000);
      camera.far = Math.max(10000, maxDim * 20);
      camera.updateProjectionMatrix();
      camera.position.set(center2.x + dist, center2.y + dist, center2.z + dist);
      controls.target.copy(center2);
      controls.update();

      // keep lints happy (size used for debugging if needed)
      void size;
    };
  }, []);

  const applyViewPreset = useMemo(() => {
    return (kind) => {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return;

      const c = viewCenterRef.current.clone();
      const dist = viewDistRef.current || 50;

      camera.up.set(0, 1, 0);

      if (kind === "top") {
        camera.position.set(c.x, c.y + dist, c.z);
      } else if (kind === "front") {
        camera.position.set(c.x, c.y, c.z + dist);
      } else {
        camera.position.set(c.x + dist, c.y + dist, c.z + dist);
      }

      controls.target.copy(c);
      controls.update();
    };
  }, []);

  useEffect(() => {
    ensureInteractiveViewer();

    const mount = mountRef.current;
    if (!mount) return;

    const ro = new ResizeObserver(() => {
      const renderer = rendererRef.current;
      const camera = cameraRef.current;
      if (!renderer || !camera) return;
      const w = mount.clientWidth || 800;
      const h = mount.clientHeight || 500;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });

    ro.observe(mount);

    return () => {
      try {
        ro.disconnect();
      } catch {
        // ignore
      }
    };
  }, [ensureInteractiveViewer]);

  useEffect(() => {
    if (!lastObjText) return;
    try {
      setObjInViewer(lastObjText);
    } catch (e) {
      setLastError(String(e?.message || e));
    }
  }, [lastObjText, setObjInViewer]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;

      try {
        if (meshRef.current && sceneRef.current) sceneRef.current.remove(meshRef.current);
      } catch {
        // ignore
      }
      try {
        meshRef.current?.geometry?.dispose?.();
      } catch {
        // ignore
      }
      try {
        meshRef.current?.material?.dispose?.();
      } catch {
        // ignore
      }
      meshRef.current = null;

      try {
        controlsRef.current?.dispose?.();
      } catch {
        // ignore
      }
      controlsRef.current = null;

      try {
        rendererRef.current?.dispose?.();
      } catch {
        // ignore
      }
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  const requestSnapshot = useMemo(() => {
    return async () => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setStatus("Rendering snapshot…");
      setLastError("");

      return new Promise((resolve) => {
        let done = false;

        const cleanup = () => {
          window.removeEventListener("grasshopper:render-snapshot", onSnap);
        };

        const onSnap = (ev) => {
          const detail = ev?.detail;
          if (!detail || detail.requestId !== requestId) return;
          done = true;
          cleanup();

          if (detail.ok && detail.dataUrl) {
            setImgUrl(detail.dataUrl);
            setStatus("Ready");
            resolve(true);
            return;
          }

          const msg = detail?.error ? String(detail.error) : "Snapshot failed";
          setLastError(msg);
          setStatus("Error");
          resolve(false);
        };

        window.addEventListener("grasshopper:render-snapshot", onSnap);
        window.dispatchEvent(
          new CustomEvent("grasshopper:request-render-snapshot", {
            detail: { requestId, overlayOnly: true, width: 1280, height: 720 },
          })
        );

        window.setTimeout(() => {
          if (done) return;
          cleanup();
          setLastError("Snapshot timeout (viewer did not respond)");
          setStatus("Error");
          resolve(false);
        }, 3000);
      });
    };
  }, []);

  const renderFromSchema = useMemo(() => {
    return async (schema) => {
      const res = await requestObjFromViewer();
      if (res?.ok && res.objText) {
        try {
          setStatus("Rendering OBJ…");
          setLastError("");
          setLastObjText(res.objText);
          setObjInViewer(res.objText);
          setStatus("Ready");
          return true;
        } catch (e) {
          setLastError(String(e?.message || e));
          setStatus("Error");
          return false;
        }
      }

      const msg = res?.error ? String(res.error) : "OBJ export failed";
      setLastError(msg);
      await requestSnapshot();
      return false;
    };
  }, [renderObjToDataUrl, requestObjFromViewer, requestSnapshot]);

  useEffect(() => {
    const onGhResult = (ev) => {
      const schema = ev?.detail?.schema;
      renderFromSchema(schema);
    };
    window.addEventListener("grasshopper:result", onGhResult);
    return () => window.removeEventListener("grasshopper:result", onGhResult);
  }, [renderFromSchema]);

  return (
    <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: 10 }}>
        <div style={{ fontSize: 12, color: "rgba(229,231,235,0.9)" }}>{status}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={() => applyViewPreset("reset")}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Reset View
          </button>

          <button
            type="button"
            onClick={() => centerAndGround()}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Center & Ground
          </button>

          <button
            type="button"
            onClick={() => applyViewPreset("top")}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Top View
          </button>

          <button
            type="button"
            onClick={() => applyViewPreset("front")}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Front View
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: rotDeg.x, y: rotDeg.y - 90, z: rotDeg.z })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Rotate Left
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: 0, y: 0, z: 0 })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Lay Flat
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: -90, y: 0, z: 0 })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Z-up → Y-up
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: rotDeg.x, y: rotDeg.y + 90, z: rotDeg.z })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Rotate Right
          </button>

          <button
            type="button"
            onClick={() => applyRotationToMesh({ x: 0, y: 0, z: 0 })}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Reset Rotation
          </button>

          <button
            type="button"
            onClick={() => {
              if (!lastObjText) return;
              try {
                const blob = new Blob([lastObjText], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `grasshopper-${Date.now()}.obj`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch {
                // ignore
              }
            }}
            disabled={!lastObjText}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: lastObjText ? "pointer" : "not-allowed",
              opacity: lastObjText ? 1 : 0.6,
            }}
          >
            Download OBJ
          </button>

          <button
            type="button"
            onClick={async () => {
              if (lastObjText) {
                try {
                  setStatus("Rendering OBJ…");
                  setLastError("");
                  setObjInViewer(lastObjText);
                  setStatus("Ready");
                  return;
                } catch (e) {
                  setLastError(String(e?.message || e));
                  setStatus("Error");
                  return;
                }
              }

              const res = await requestObjFromViewer();
              if (res?.ok && res.objText) {
                try {
                  setStatus("Rendering OBJ…");
                  setLastError("");
                  setLastObjText(res.objText);
                  setObjInViewer(res.objText);
                  setStatus("Ready");
                  return;
                } catch (e) {
                  setLastError(String(e?.message || e));
                  setStatus("Error");
                  return;
                }
              }

              const msg = res?.error ? String(res.error) : "OBJ export failed";
              setLastError(msg);
              requestSnapshot();
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "rgba(0,0,0,0.22)" }}>
        {lastError ? (
          <div style={{ padding: 12, fontSize: 12, color: "rgba(248,113,113,0.95)" }}>{lastError}</div>
        ) : null}
        <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
      </div>
    </div>
  );
}

export default GrasshopperRenderPanel;

import React, { useEffect, useMemo, useState } from "react";

function GrasshopperPanel() {
  const defaultPointer = useMemo(() => {
    const env = import.meta?.env?.VITE_GRASSHOPPER_POINTER_URL;
    if (env) return env;
    if (typeof window !== "undefined") {
      return `${window.location.origin}/gh/unnamed.gh`;
    }
    return "/gh/unnamed.gh";
  }, []);

  const [pointerUrl, setPointerUrl] = useState(defaultPointer);
  const [statusText, setStatusText] = useState("");
  const [detailsText, setDetailsText] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [lastRequestText, setLastRequestText] = useState("");

  const [edgeLengthFactor, setEdgeLengthFactor] = useState(0.01);
  const [lineLengthStrength, setLineLengthStrength] = useState(8);
  const [lineLengthFactor, setLineLengthFactor] = useState(0.5);
  const [loadFactor, setLoadFactor] = useState(1.62134);
  const [runToggle, setRunToggle] = useState(true);
  const [resetPulse, setResetPulse] = useState(false);

  const [x, setX] = useState(10);
  const [h, setH] = useState(8);
  const [z, setZ] = useState(5);

  const [isLoadingSolve, setIsLoadingSolve] = useState(false);

  const [curveItems, setCurveItems] = useState([]);

  const requestCurvesFromViewer = () => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      let done = false;
      const onResp = (ev) => {
        const detail = ev?.detail;
        if (!detail || detail.requestId !== requestId) return;
        done = true;
        window.removeEventListener("grasshopper:curves-response", onResp);
        resolve(Array.isArray(detail.items) ? detail.items : []);
      };

      window.addEventListener("grasshopper:curves-response", onResp);
      window.dispatchEvent(new CustomEvent("grasshopper:request-curves", { detail: { requestId } }));

      window.setTimeout(() => {
        if (done) return;
        window.removeEventListener("grasshopper:curves-response", onResp);
        resolve(null);
      }, 300);
    });
  };

  useEffect(() => {
    const onCurves = (ev) => {
      const detail = ev?.detail;
      if (!detail || detail.paramName !== "cr") return;
      const items = detail.items;
      if (!Array.isArray(items)) return;
      setCurveItems(items);
    };

    window.addEventListener("grasshopper:input-curves", onCurves);
    return () => window.removeEventListener("grasshopper:input-curves", onCurves);
  }, []);

  const normalizePointer = (url) => {
    const u = String(url || "").trim();
    if (!u) return u;
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    if (typeof window !== "undefined" && u.startsWith("/")) {
      return `${window.location.origin}${u}`;
    }
    return u;
  };

  const withCacheBust = (url) => {
    try {
      const u = new URL(url);
      u.searchParams.set("__cb", String(Date.now()));
      return u.toString();
    } catch {
      const sep = String(url).includes("?") ? "&" : "?";
      return `${url}${sep}__cb=${Date.now()}`;
    }
  };

  const buildNumericValue = (paramName, value) => {
    return {
      ParamName: paramName,
      InnerTree: {
        "{ 0; }": [
          {
            type: "System.Double",
            data: String(value),
          },
        ],
      },
    };
  };

  const buildBooleanValue = (paramName, value) => {
    return {
      ParamName: paramName,
      InnerTree: {
        "{ 0; }": [
          {
            type: "System.Boolean",
            data: value ? "true" : "false",
          },
        ],
      },
    };
  };

  const defaultValues = useMemo(() => {
    return [];
  }, []);

  const buildCurveListValue = (paramName, items) => {
    return {
      ParamName: paramName,
      InnerTree: {
        "{ 0; }": (items || []).map((it) => ({ type: it.type, data: it.data })),
      },
    };
  };

  const runSolve = async () => {
    setIsLoadingSolve(true);
    setStatusText("");
    setDetailsText("");
    setLastRequestText("");
    try {
      const respItems = await requestCurvesFromViewer();
      if (Array.isArray(respItems)) setCurveItems(respItems);

      const currentCurves = Array.isArray(respItems) ? respItems : curveItems;

      try {
        await fetch("/api/compute/params", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x,
            h,
            z,
            edge: edgeLengthFactor,
            lineStrength: lineLengthStrength,
            lineFactor: lineLengthFactor,
            load: loadFactor,
            reset: resetPulse,
            run: runToggle,
            cr: Array.isArray(currentCurves) ? currentCurves : [],
          }),
        });
      } catch {
        // ignore
      }

      const pointer = withCacheBust(normalizePointer(pointerUrl));

      const values = [];
      if (Array.isArray(currentCurves) && currentCurves.length) {
        values.push(buildCurveListValue("cr", currentCurves));
      }

      values.push(buildNumericValue("EdgeLengthFactor", edgeLengthFactor));
      values.push(buildNumericValue("LineLengthStrength", lineLengthStrength));
      values.push(buildNumericValue("LineLengthFactor", lineLengthFactor));
      values.push(buildNumericValue("LoadFactor", loadFactor));

      values.push(buildNumericValue("x", x));
      values.push(buildNumericValue("h", h));
      values.push(buildNumericValue("z", z));

      values.push(buildBooleanValue("RUn", runToggle));
      if (resetPulse) values.push(buildBooleanValue("Reset", true));

      const payload = {
        pointer,
        values,
      };

      try {
        setLastRequestText(JSON.stringify(payload, null, 2));
      } catch {
        setLastRequestText(String(payload));
      }

      const res = await fetch("/compute/grasshopper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (res.ok) {
        let outCount = 0;
        try {
          const schema = JSON.parse(text);
          outCount = Array.isArray(schema?.values) ? schema.values.length : 0;
          console.log("[GH] solve OK", { outputs: outCount });
          window.dispatchEvent(new CustomEvent("grasshopper:result", { detail: { schema } }));
        } catch {
          // ignore
        }
        setStatusText(outCount > 0 ? `OK (${outCount} outputs)` : "OK");
      } else {
        setStatusText(`${res.status} ${res.statusText}`);
      }
      setDetailsText(text);
    } catch (e) {
      setStatusText("Request failed");
      setDetailsText(String(e));
    } finally {
      if (resetPulse) setResetPulse(false);
      setIsLoadingSolve(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>GH URL</div>
        <input
          value={pointerUrl}
          onChange={(e) => setPointerUrl(e.target.value)}
          style={{
            flex: "1 1 320px",
            minWidth: 220,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(0,0,0,0.25)",
            color: "#e5e7eb",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={runSolve}
          disabled={isLoadingSolve}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(15,118,110,0.85)",
            color: "#e5e7eb",
            cursor: isLoadingSolve ? "wait" : "pointer",
          }}
        >
          {isLoadingSolve ? "Running..." : "Run"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>EdgeLengthFactor: {edgeLengthFactor}</div>
            <input
              type="range"
              min={0.001}
              max={1}
              step={0.001}
              value={edgeLengthFactor}
              onChange={(e) => setEdgeLengthFactor(Number(e.target.value))}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>LineLengthStrength: {lineLengthStrength}</div>
            <input
              type="range"
              min={0}
              max={20}
              step={1}
              value={lineLengthStrength}
              onChange={(e) => setLineLengthStrength(Number(e.target.value))}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>LineLengthFactor: {lineLengthFactor}</div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={lineLengthFactor}
              onChange={(e) => setLineLengthFactor(Number(e.target.value))}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>LoadFactor: {loadFactor}</div>
            <input
              type="range"
              min={0}
              max={5}
              step={0.01}
              value={loadFactor}
              onChange={(e) => setLoadFactor(Number(e.target.value))}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>x: {x}</div>
            <input type="range" min={1} max={20} step={1} value={x} onChange={(e) => setX(Number(e.target.value))} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>h: {h}</div>
            <input type="range" min={1} max={20} step={1} value={h} onChange={(e) => setH(Number(e.target.value))} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>z: {z}</div>
            <input type="range" min={1} max={20} step={1} value={z} onChange={(e) => setZ(Number(e.target.value))} />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setResetPulse(true)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Reset
          </button>

          <button
            type="button"
            onClick={() => setRunToggle((v) => !v)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: runToggle ? "rgba(34,197,94,0.85)" : "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            RUn: {runToggle ? "True" : "False"}
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>Curves (cr):</div>
          <div style={{ color: "#e5e7eb", fontSize: 12 }}>{Array.isArray(curveItems) ? curveItems.length : 0}</div>
          <button
            type="button"
            onClick={() => setCurveItems([])}
            disabled={!Array.isArray(curveItems) || curveItems.length === 0}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: Array.isArray(curveItems) && curveItems.length ? "pointer" : "not-allowed",
              opacity: Array.isArray(curveItems) && curveItems.length ? 1 : 0.5,
            }}
          >
            Clear curves
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ color: "#e5e7eb", fontSize: 12, opacity: 0.9 }}>Status:</div>
          <div style={{ color: "#e5e7eb", fontSize: 12 }}>{statusText}</div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            disabled={!detailsText}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(17,24,39,0.8)",
              color: "#e5e7eb",
              cursor: detailsText ? "pointer" : "not-allowed",
              opacity: detailsText ? 1 : 0.5,
            }}
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
        </div>

        {showDetails && (
          <pre
            style={{
              margin: 0,
              padding: 10,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(0,0,0,0.25)",
              color: "#e5e7eb",
              overflow: "auto",
              minHeight: 0,
              flex: 1,
              fontSize: 12,
            }}
          >
            {lastRequestText ? `REQUEST\n${lastRequestText}\n\n` : ""}
            {detailsText ? `RESPONSE\n${detailsText}` : ""}
          </pre>
        )}
      </div>
    </div>
  );
}

export default GrasshopperPanel;

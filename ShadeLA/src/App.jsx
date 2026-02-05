import React, { useEffect, useMemo, useState } from "react";
import "./App.css";
import PowerBIReport from "./components/PowerBIReport";
import GrasshopperPanel from "./components/GrasshopperPanel";
import RhinoViewer from "./components/RhinoViewer";
import CanopyTreesSection from "./components/CanopyTreesSection";
import ResourcesSections from "./components/ResourcesSections";

function App() {
  const [selectedArea, setSelectedArea] = useState(null);
  const [mapUnlocked, setMapUnlocked] = useState(false);

  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem("shadela:sidebarHidden") === "true";
    } catch {
      return false;
    }
  });

  const [tocQuery, setTocQuery] = useState("");

  const cadMapperUrl = import.meta.env.VITE_CADMAPPER_URL || "http://localhost:3001";

  const tocItems = useMemo(
    () => [
      { href: "#overview", label: "Overview" },
      { href: "#analytics", label: "PowerBI" },
      { href: "#workspace", label: "Map + Unreal" },
      { href: "#canopy-trees", label: "Canopy / Trees" },
      { href: "#resources", label: "Resources" },
    ],
    []
  );

  const filteredTocItems = useMemo(() => {
    const q = tocQuery.trim().toLowerCase();
    if (!q) return tocItems;
    return tocItems.filter((i) => i.label.toLowerCase().includes(q));
  }, [tocItems, tocQuery]);

  useEffect(() => {
    try {
      localStorage.setItem("shadela:sidebarHidden", sidebarHidden ? "true" : "false");
    } catch {
      // ignore
    }
  }, [sidebarHidden]);

  useEffect(() => {
    const links = Array.from(document.querySelectorAll("#toc a"));
    const sections = links
      .map((a) => {
        const id = a.getAttribute("href");
        if (!id) return null;
        return document.querySelector(id);
      })
      .filter(Boolean);

    if (!sections.length) return;

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = `#${e.target.id}`;
          links.forEach((x) => x.classList.remove("active"));
          const link = links.find((a) => a.getAttribute("href") === id);
          link?.classList.add("active");
        }
      },
      { rootMargin: "-30% 0px -60% 0px", threshold: 0.01 }
    );

    sections.forEach((s) => obs.observe(s));
    return () => obs.disconnect();
  }, [filteredTocItems.length]);

  useEffect(() => {
    if (!mapUnlocked) return;

    const onMouseDown = (e) => {
      const mapEl = document.getElementById("Map");
      if (!mapEl) return;
      if (mapEl.contains(e.target)) return;
      setMapUnlocked(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [mapUnlocked]);

  return (
    <div className={`usgbc-app${sidebarHidden ? " sidebar-hidden" : ""}`}>
      <button className="show-sidebar" type="button" onClick={() => setSidebarHidden(false)}>
        ☰ Menu
      </button>

      <nav id="sidebar">
        <div className="brand">
          <div className="logo" aria-hidden="true" />
          <h1>ShadeLA</h1>
          <button
            type="button"
            className="hide-btn"
            title="Hide sidebar"
            onClick={() => setSidebarHidden(true)}
          >
            ×
          </button>
        </div>

        <div className="search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M21 21l-4.2-4.2M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <input
            value={tocQuery}
            onChange={(e) => setTocQuery(e.target.value)}
            placeholder="Search sections…"
          />
        </div>

        <div className="toc" id="toc">
          <div className="group">ShadeLA</div>
          {filteredTocItems.map((i) => (
            <a key={i.href} href={i.href}>
              {i.label}
            </a>
          ))}
        </div>
      </nav>

      <main>
        <section className="hero" id="overview">
          <div>
            <h2>Shade-LA</h2>
            <p>
              Shade-LA is a digital twin–based visualization and analysis platform focused on urban shade
              infrastructure in Los Angeles. The project integrates geospatial data, 3D visualization,
              parametric design tools, and analytics dashboards to support heat-mitigation planning,
              environmental analysis, and design exploration.
            </p>
            <p>
              Shade-LA brings together multiple tools and visual layers to explore shade coverage, canopy
              assets, and environmental performance. It is designed for researchers, planners, designers,
              and students interested in urban heat mitigation, digital twins, and data-driven design.
            </p>
          </div>
        </section>

          <section id="analytics" className="panel panel-analytics">
            <div className="panel-header">
              <h2>POWERBI – SHADELA</h2>
            </div>
            <div className="panel-body right-body">
              <div className="right-powerbi">
                <PowerBIReport selectedArea={selectedArea} />
              </div>
            </div>
          </section>

        <section className="panel" id="workspace">
          <h3>Workspace</h3>
          <div className="workspace-grid">
            <section className="panel panel-map panel-map-top">
              
              <div className="panel-body">
                <div
                  id="Map"
                  className={mapUnlocked ? "map-unlocked" : "map-locked"}
                  style={{ position: "absolute", inset: 0 }}
                  onClick={() => {
                    if (!mapUnlocked) setMapUnlocked(true);
                  }}
                >
                  {mapUnlocked && (
                    <button
                      type="button"
                      className="map-lock-btn"
                      onClick={() => setMapUnlocked(false)}
                      title="Disable map interaction"
                    >
                      Lock map
                    </button>
                  )}
                  {!mapUnlocked && (
                    <div className="map-lock-overlay" role="button" tabIndex={0}>
                      Click to activate the map
                    </div>
                  )}
                  <iframe
                    title="CadMapper"
                    src={cadMapperUrl}
                    style={{
                      width: "100%",
                      height: "100%",
                      border: 0,
                      pointerEvents: mapUnlocked ? "auto" : "none",
                    }}
                    allow="fullscreen"
                  />
                </div>
              </div>
            </section>

            <section className="panel panel-model">
              <div className="panel-header">
                <h2>Model</h2>
              </div>
              <div className="panel-body">
                <RhinoViewer />
              </div>
            </section>

            <section className="panel panel-grasshopper">
              <div className="panel-header">
                <h2>Grasshopper</h2>
              </div>
              <div className="panel-body">
                <GrasshopperPanel />
              </div>
            </section>
          </div>
        </section>

        <CanopyTreesSection />
        <ResourcesSections />
      </main>
    </div>
  );
}

export default App;

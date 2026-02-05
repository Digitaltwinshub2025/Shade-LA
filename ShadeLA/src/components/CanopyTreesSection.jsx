import React, { useEffect, useMemo, useState } from "react";

function CanopyTreesSection() {
  const canopyImages = useMemo(
    () => [
      { src: "/Images/Shade1%20(1).png", alt: "Shade 1" },
      { src: "/Images/Shade2.png", alt: "Shade 2" },
      { src: "/Images/Shade4.png", alt: "Shade 4" },
    ],
    []
  );

  const treeImages = useMemo(
    () => [
      { src: "/Images/Tree1.jpeg", alt: "Tree 1" },
      { src: "/Images/Tree2.png", alt: "Tree 2" },
    ],
    []
  );

  const [canopyIndex, setCanopyIndex] = useState(0);
  const [treeIndex, setTreeIndex] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => {
      setCanopyIndex((i) => (i + 1) % canopyImages.length);
      setTreeIndex((i) => (i + 1) % treeImages.length);
    }, 3000);
    return () => window.clearInterval(t);
  }, [canopyImages.length, treeImages.length]);

  return (
    <section className="panel" id="canopy-trees">
      <div className="panel-header">
        <h2>Canopy / Trees</h2>
      </div>
      <div className="panel-body resources-body">
        <div className="resources-original">
          <div className="grid-2">
            <section className="card" id="canopy">
              <div className="card__header">
                <h2 className="section-title">CANOPY</h2>
              </div>

              <div className="embed embed--preview" data-embed-slot="canopy">
                <div className="slideshow" data-slideshow="canopy" aria-label="Canopy slideshow">
                  {canopyImages.map((img, idx) => (
                    <img
                      key={img.src}
                      className={`slideshow__img${idx === canopyIndex ? " is-active" : ""}`}
                      src={img.src}
                      alt={img.alt}
                      loading={idx === 0 ? "eager" : "lazy"}
                    />
                  ))}
                </div>
                <div className="embed__placeholder">
                  <div className="embed__placeholderTitle">Canopy</div>
                </div>
              </div>

              <div className="embed-actions" data-embed-action-slot="canopy" />
            </section>

            <section className="card" id="trees">
              <div className="card__header">
                <h2 className="section-title">TREES</h2>
              </div>

              <div className="embed embed--preview" data-embed-slot="trees">
                <div className="slideshow" data-slideshow="trees" aria-label="Trees slideshow">
                  {treeImages.map((img, idx) => (
                    <img
                      key={img.src}
                      className={`slideshow__img${idx === treeIndex ? " is-active" : ""}`}
                      src={img.src}
                      alt={img.alt}
                      loading={idx === 0 ? "eager" : "lazy"}
                    />
                  ))}
                </div>
                <div className="embed__placeholder">
                  <div className="embed__placeholderTitle">Trees</div>
                  <div className="embed__placeholderText">
                    Add <code>Trees.png</code> or paste an embed URL into <code>app.js</code>.
                  </div>
                </div>
              </div>

              <div className="embed-actions" data-embed-action-slot="trees" />
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}

export default CanopyTreesSection;

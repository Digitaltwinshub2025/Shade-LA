import React, { useEffect, useMemo, useState } from "react";

function ResourcesSections() {
  const canopyImages = useMemo(
    () => [
      { src: "/Images/Shade1%20(1).png", alt: "Shade 1" },
      { src: "/Images/Shade2.png", alt: "Shade 2" },
      { src: "/Images/Shade3.png", alt: "Shade 3" },
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
    <section className="panel" id="resources">
      <div className="panel-header">
        <h2>Resources</h2>
      </div>
      <div className="panel-body resources-body">
        <div className="resources-embed">
          <div className="resources-embed__title">SHADE LA and NASA JPL</div>
          <div className="resources-embed__subtitle">Fall 2025</div>
          <div className="resources-embed__frameWrap">
            <iframe
              className="resources-embed__frame"
              src="https://docs.google.com/presentation/d/1vvPeb8UAam5diOklqXiCtg_gKmWP0W-ja35KHTXteA0/embed?start=false&loop=false&delayms=3000"
              allowFullScreen
              title="SHADE LA and NASA JPL Slides"
            />
          </div>
        </div>

        <div className="resources-embed">
          <div className="resources-embed__title">SHADE LA POSTER & RHINO/SKETCHUP FILE</div>
          <div className="resources-embed__frameWrap">
            <iframe
              className="resources-embed__frame"
              src="https://docs.google.com/presentation/d/1UNJFyagHKlXVxsVKjO_JvttP-24s8fnz32RBHClqbI8/embed?start=false&loop=false&delayms=3000&slide=id.g3b189f6e42a_0_0"
              allowFullScreen
              title="SHADE LA Poster Slides"
            />
          </div>
        </div>

        <div className="resources-embed">
          <div className="resources-embed__title">Aura Reports</div>
          <div className="resources-embed__frameWrap">
            <iframe
              className="resources-embed__frame"
              src="/Shade%20LA_%20Transforming%20Urban%20Heat%20Islands%20in%20South%20Los%20Angeles%20Census%20Tracts%205351.01,%202430,%202382,%20and%202240.10%20through%20Equitable%20Shade%20Structures%20and%20Regenerative%20Design.pdf"
              title="Aura Reports PDF"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export default ResourcesSections;

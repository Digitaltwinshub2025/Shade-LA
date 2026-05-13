import React from "react";

function PowerBIReport() {
  const embedUrl =
    "https://app.powerbi.com/view?r=eyJrIjoiMzg4ZGEzM2MtYTc4Ny00YTIwLTg2YTEtZTllMzU1YWFjOWU0IiwidCI6ImY2NzMxODgxLWE3NGYtNGM5Zi1hMzUzLTk0YjY1OGRmYTRhMyIsImMiOjZ9";

  const scale = 1.2;

  return (
    <div className="powerbi-wrapper-outer">
      <iframe
        className="powerbi-embed"
        title="ShadeLa"
        src={embedUrl}
        style={{
          width: `${100 / scale}%`,
          height: `${100 / scale}%`,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }}
        allowFullScreen
      />
    </div>
  );
}

export default PowerBIReport;

import React from "react";

function PowerBIReport() {
  const embedUrl =
    "https://app.powerbi.com/reportEmbed?reportId=31137e43-9ad3-4c68-be9c-1d04d2d30965&autoAuth=true&ctid=0b71261a-495f-4ea9-9911-da844b9402ef";

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

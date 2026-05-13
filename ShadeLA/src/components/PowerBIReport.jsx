import React from "react";

function PowerBIReport() {
  const embedUrl =
    "https://app.powerbi.com/view?r=https://nam04.safelinks.protection.outlook.com/?url=https%3A%2F%2Fapp.powerbi.com%2Fview%3Fr%3DeyJrIjoiMzg4ZGEzM2MtYTc4Ny00YTIwLTg2YTEtZTllMzU1YWFjOWU0IiwidCI6ImY2NzMxODgxLWE3NGYtNGM5Zi1hMzUzLTk0YjY1OGRmYTRhMyIsImMiOjZ9&data=05%7C02%7Cbalanv2728%40student.laccd.edu%7Ced1641fb409b4d5bf8ca08deb05a0e43%7C0b71261a495f4ea99911da844b9402ef%7C0%7C0%7C639142097998166486%7CUnknown%7CTWFpbGZsb3d8eyJFbXB0eU1hcGkiOnRydWUsIlYiOiIwLjAuMDAwMCIsIlAiOiJXaW4zMiIsIkFOIjoiTWFpbCIsIldUIjoyfQ%3D%3D%7C0%7C%7C%7C&sdata=c4vgLX4Eu81RdWHs7yTPxBS9UUlr74MHWG%2B03OQZ5c8%3D&reserved=0";

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

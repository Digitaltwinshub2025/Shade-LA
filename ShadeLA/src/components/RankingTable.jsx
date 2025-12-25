import React, { useState, useMemo } from "react";
import rankingData from "../data/rankingData.json";


const columns = [
  { key: "CityName", label: "City / Area", width: "28%" },
  { key: "Priority", label: "Priority", width: "10%" },
  { key: "Priority_score", label: "Priority Score", width: "14%" },
  { key: "High_Summer_Mean", label: "High Summer Mean", width: "16%" },
  { key: "Vul_Pop_Index", label: "Vul. Pop Index", width: "12%" },
  { key: "PCT_TreeCanopy", label: "% Tree Canopy", width: "10%" },
  { key: "PCT_LackingCanopy", label: "% Lacking Canopy", width: "10%" },
];


function RankingTable({ onSelectArea }) {
  const [sortKey, setSortKey] = useState("Priority_score");
  const [sortDir, setSortDir] = useState("desc");
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");

  const sortedRows = useMemo(() => {
    let rows = rankingData;

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((row) =>
        String(row.CityName).toLowerCase().includes(q)
      );
    }

    const sorted = [...rows].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];

      if (typeof va === "number" && typeof vb === "number") {
        return sortDir === "asc" ? va - vb : vb - va;
      }

      const sa = String(va).toLowerCase();
      const sb = String(vb).toLowerCase();
      if (sa < sb) return sortDir === "asc" ? -1 : 1;
      if (sa > sb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [sortKey, sortDir, search]);

  const handleHeaderClick = (key) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const handleRowClick = (row) => {
    setSelectedId(row.id);
    if (onSelectArea) onSelectArea(row); //  send selection up to App
  };

  const sortIndicator = (key) => {
    if (key !== sortKey) return "";
    return sortDir === "asc" ? "▲" : "▼";
  };

  return (
    <div className="ranking-root">
      <div className="ranking-toolbar">
        <div className="ranking-title">Ranking</div>
        <input
          className="ranking-search"
          type="text"
          placeholder="Search city/area..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="ranking-table-wrapper">
        <table className="ranking-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={{ width: col.width }}
                  onClick={() => handleHeaderClick(col.key)}
                >
                  <span>{col.label}</span>
                  <span className="sort-indicator">
                    {sortIndicator(col.key)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr
                key={row.id}
                className={
                  row.id === selectedId ? "ranking-row selected" : "ranking-row"
                }
                onClick={() => handleRowClick(row)}
              >
                {columns.map((col) => (
                  <td key={col.key}>{row[col.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedId && (
        <div className="ranking-footer">
          Selected area is highlighted. (And also sent to PowerBI.)
        </div>
      )}
    </div>
  );
}

export default RankingTable;

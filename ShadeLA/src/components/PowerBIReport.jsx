import React, { useRef, useEffect } from "react";
import { PowerBIEmbed } from "powerbi-client-react";
import { models } from "powerbi-client";

function PowerBIReport({ selectedArea }) {
  const reportRef = useRef(null);

  // When selection from table changes → apply filter to report
  useEffect(() => {
    if (!reportRef.current || !selectedArea) return;

    const filter = {
      $schema: "http://powerbi.com/product/schema#basic",
      target: {
        // 👇 change to actual table & column names in your PBIX
        table: "Ranking",       // e.g. your table name in the data model
        column: "CityName",     // column used in the visual
      },
      operator: "In",
      values: [selectedArea.CityName],
    };

    reportRef.current
      .setFilters([filter])
      .catch((err) => console.error("Error setting filter:", err));
  }, [selectedArea]);

  return (
    <div className="powerbi-wrapper-outer">
      <PowerBIEmbed
        cssClassName="powerbi-embed"
        embedConfig={{
          type: "report",
          id: "93af5819-0874-48a4-b918-5a207d1d4805", // your reportId
          embedUrl:
            "https://app.powerbi.com/reportEmbed?reportId=93af5819-0874-48a4-b918-5a207d1d4805&groupId=<YOUR_GROUP_ID>",
          accessToken: "<YOUR_EMBED_TOKEN>", // 🔐 must be generated on server side
          tokenType: models.TokenType.Embed,
          settings: {
            panes: {
              filters: { visible: true },
            },
          },
        }}
        eventHandlers={
          new Map([
            [
              "loaded",
              (event) => {
                reportRef.current = event.detail.report;
              },
            ],
          ])
        }
      />
    </div>
  );
}

export default PowerBIReport;

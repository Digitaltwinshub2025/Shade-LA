import CesiumMap from "@/components/CesiumMap";

export default function Home() {
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <CesiumMap />
    </div>
  );
}

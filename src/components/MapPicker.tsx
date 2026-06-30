"use client";

import dynamic from "next/dynamic";
import type { LatLng } from "./MapPickerInner";

// Leaflet touches `window`, so the map must load client-side only.
const Inner = dynamic(() => import("./MapPickerInner"), {
  ssr: false,
  loading: () => (
    <div style={{ height: 300, display: "grid", placeItems: "center", background: "#f3f3f3", borderRadius: 8 }}>
      Loading map…
    </div>
  ),
});

export type { LatLng };

export default function MapPicker(props: { value: LatLng | null; onChange: (v: LatLng) => void }) {
  return <Inner {...props} />;
}

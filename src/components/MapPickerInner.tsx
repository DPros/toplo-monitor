"use client";

import { MapContainer, TileLayer, Marker, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet's default marker images break under bundlers; point them at the CDN.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

export type LatLng = { lat: number; lng: number };

// Sofia city centre — the initial view before a pin is dropped.
const SOFIA: LatLng = { lat: 42.6977, lng: 23.3219 };

function PinLayer({ value, onChange }: { value: LatLng | null; onChange: (v: LatLng) => void }) {
  useMapEvents({
    click(e) {
      onChange({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  if (!value) return null;
  return (
    <Marker
      position={[value.lat, value.lng]}
      draggable
      eventHandlers={{
        dragend(e) {
          const p = (e.target as L.Marker).getLatLng();
          onChange({ lat: p.lat, lng: p.lng });
        },
      }}
    />
  );
}

export default function MapPickerInner({
  value,
  onChange,
}: {
  value: LatLng | null;
  onChange: (v: LatLng) => void;
}) {
  const center = value ?? SOFIA;
  return (
    <MapContainer
      center={[center.lat, center.lng]}
      zoom={12}
      style={{ height: 300, width: "100%", borderRadius: 8 }}
      scrollWheelZoom
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      <PinLayer value={value} onChange={onChange} />
    </MapContainer>
  );
}

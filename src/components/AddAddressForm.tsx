"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import MapPicker, { type LatLng } from "@/components/MapPicker";
import { createAddress, type CreateAddressState } from "@/app/cabinet/actions";

const initial: CreateAddressState = {};
const input: React.CSSProperties = { padding: 8, border: "1px solid #ccc", borderRadius: 6 };

export default function AddAddressForm() {
  const [pos, setPos] = useState<LatLng | null>(null);
  const [state, action, pending] = useActionState(createAddress, initial);
  const formRef = useRef<HTMLFormElement>(null);

  // Reset the form + pin after a successful add.
  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setPos(null);
    }
  }, [state.ok]);

  return (
    <form ref={formRef} action={action} style={{ display: "grid", gap: 10 }}>
      <h2 style={{ marginBottom: 0 }}>Add an address</h2>

      <input name="label" placeholder="Label (e.g. Home)" required style={input} />

      <div>
        <p style={{ margin: "4px 0", color: "#555", fontSize: 14 }}>
          Click the map to drop a pin (drag to fine-tune). This sets the exact location used for matching.
        </p>
        <MapPicker value={pos} onChange={setPos} />
        <input type="hidden" name="lat" value={pos?.lat ?? ""} />
        <input type="hidden" name="lng" value={pos?.lng ?? ""} />
        {pos && (
          <p style={{ margin: "6px 0 0", color: "#777", fontSize: 13 }}>
            Pinned at {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}
          </p>
        )}
      </div>

      <details>
        <summary style={{ cursor: "pointer", color: "#555" }}>Optional text details (fallback matching)</summary>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <input name="neighborhood" placeholder="Neighborhood (e.g. Борово)" style={input} />
          <input name="street" placeholder="Street (e.g. Топли дол)" style={input} />
          <div style={{ display: "flex", gap: 8 }}>
            <input name="houseNumber" placeholder="House № (e.g. 1а)" style={{ ...input, flex: 1 }} />
            <input name="block" placeholder="Block (e.g. 206)" style={{ ...input, flex: 1 }} />
          </div>
        </div>
      </details>

      {state.error && <p style={{ color: "crimson", margin: 0 }}>{state.error}</p>}

      <button type="submit" disabled={pending || !pos} style={{ padding: "8px 14px", justifySelf: "start" }}>
        {pending ? "Adding…" : "Add address"}
      </button>
    </form>
  );
}

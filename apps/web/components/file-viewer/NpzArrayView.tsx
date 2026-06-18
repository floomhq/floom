"use client";

import { useEffect, useState } from "react";
import { LoadingState } from "@/components/collection/CollectionStates";
import { parseNpzArrays, shapeLabel, dtypeLabel, type NpzArrayInfo } from "@/lib/file-viewer/npz";

function sizeLabel(bytes?: number): string {
  if (typeof bytes !== "number" || bytes <= 0) return "";
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

// .npz inline viewer: a flat table of the archive's arrays (name, shape,
// dtype, size), parsed header-only (no numpy, no array-data load). Mirrors the
// SqliteTableView visual treatment: flat, tokens, mono table.
export function NpzArrayView({ load }: { load: () => Promise<ArrayBuffer> }) {
  const [arrays, setArrays] = useState<NpzArrayInfo[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    load()
      .then((buf) => parseNpzArrays(buf))
      .then((a) => alive && setArrays(a))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err) return <div style={{ color: "var(--muted-foreground)", padding: 14 }}>Could not read this archive.</div>;
  if (!arrays) return <LoadingState rows={3} />;
  if (arrays.length === 0)
    return <div style={{ color: "var(--muted-foreground)", padding: 14 }}>This archive has no arrays.</div>;

  return (
    <div>
      <div style={{ overflow: "auto", border: "var(--bd-list)", borderRadius: "var(--radius-card)" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--font-mono)", width: "100%" }}>
          <thead>
            <tr>
              {["array", "shape", "dtype", "size"].map((c) => (
                <th
                  key={c}
                  style={{ textAlign: "left", padding: "6px 10px", borderBottom: "var(--bd-div)", color: "var(--ink-soft)" }}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {arrays.map((a) => (
              <tr key={a.name}>
                <td style={{ padding: "6px 10px", borderBottom: "var(--bd-div)", color: "var(--ink-soft)" }}>{a.name}</td>
                <td style={{ padding: "6px 10px", borderBottom: "var(--bd-div)", color: "var(--ink-soft)" }}>
                  {shapeLabel(a.shape)}
                </td>
                <td style={{ padding: "6px 10px", borderBottom: "var(--bd-div)", color: "var(--ink-soft)" }} title={a.dtype}>
                  {dtypeLabel(a.dtype)}
                </td>
                <td style={{ padding: "6px 10px", borderBottom: "var(--bd-div)", color: "var(--muted-foreground)" }}>
                  {sizeLabel(a.sizeBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ marginTop: 8, fontSize: 11, color: "var(--muted-foreground)" }}>
        {arrays.length} {arrays.length === 1 ? "array" : "arrays"} · header-only preview (no data loaded)
      </p>
    </div>
  );
}

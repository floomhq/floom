"use client";

import { useEffect, useState } from "react";
import type { SqliteView } from "@/lib/types";
import { LoadingState } from "@/components/collection/CollectionStates";

// #777: inline SQLite table viewer — table picker + rows, read-only.
export function SqliteTableView({ load }: { load: (table?: string) => Promise<SqliteView> }) {
  const [view, setView] = useState<SqliteView | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    load()
      .then((v) => {
        setView(v);
        if (v.tables[0]) setActive(v.tables[0]);
      })
      .catch(() => setErr(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    load(active)
      .then((v) => alive && setView(v))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (err) return <div style={{ color: "var(--muted-foreground)", padding: 14 }}>Could not read this database.</div>;
  if (!view) return <LoadingState rows={3} />;
  if (view.tables.length === 0)
    return <div style={{ color: "var(--muted-foreground)", padding: 14 }}>This database has no tables.</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {view.tables.map((t) => (
          <button
            key={t}
            type="button"
            className="c-vpill"
            style={{
              padding: "3px 10px",
              fontFamily: "var(--font-mono)",
              background: t === active ? "var(--accent-soft)" : undefined,
              color: t === active ? "var(--ink)" : undefined,
            }}
            onClick={() => setActive(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {view.columns && view.rows ? (
        <div style={{ overflow: "auto", borderRadius: "var(--radius-ui)" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--font-mono)", width: "100%" }}>
            <thead>
              <tr>
                {view.columns.map((c) => (
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
              {view.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} style={{ padding: "6px 10px", borderBottom: "var(--bd-div)", color: "var(--ink-soft)" }}>
                      {cell === null ? "NULL" : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {view.truncated && (
        <p style={{ marginTop: 8, fontSize: 11, color: "var(--muted-foreground)" }}>
          Showing the first {view.row_count} rows.
        </p>
      )}
    </div>
  );
}

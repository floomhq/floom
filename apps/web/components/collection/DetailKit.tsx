import type { ReactNode } from "react";

type DetailFact = {
  key: string;
  label: ReactNode;
  value: ReactNode;
};

type DetailChip = string | {
  key: string;
  label: ReactNode;
  add?: boolean;
};

export function DetailSummary({ items }: { items: DetailFact[] }) {
  if (items.length === 0) return null;
  return (
    <div className="c-dsum">
      {items.map((item) => (
        <div className="s" key={item.key}>
          <div className="v">{item.value}</div>
          <div className="k">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

export function DetailGroup({ label, children }: { label?: ReactNode; children: ReactNode }) {
  return (
    <section className="c-dgrp">
      {label != null && <div className="c-dgl">{label}</div>}
      {children}
    </section>
  );
}

export function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="c-drow">
      <span className="k">{label}</span>
      <span className={mono ? "v mono" : "v"}>{value}</span>
    </div>
  );
}

export function DetailPair({ items }: { items: DetailFact[] }) {
  if (items.length === 0) return null;
  return (
    <div className="c-d2">
      {items.map((item) => (
        <div key={item.key}>
          <div className="k">{item.label}</div>
          <div className="v">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export function DetailChips({ items }: { items: DetailChip[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      {items.map((item) => {
        const key = typeof item === "string" ? item : item.key;
        const label = typeof item === "string" ? item : item.label;
        const add = typeof item === "string" ? item.trim().startsWith("+") : item.add === true;
        return (
          <span key={key} className={add ? "c-dchip add" : "c-dchip"}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

export function DetailEmpty({ children }: { children: ReactNode }) {
  return <div className="c-dempty">{children}</div>;
}

export function DetailNote({ children }: { children: ReactNode }) {
  return <p className="c-dnote">{children}</p>;
}

/**
 * `separated` is for orphan action rows without a preceding `DetailGroup`.
 * Rows that already follow a detail group get the divider from the sibling CSS.
 */
export function DetailActions({
  children,
  separated = false,
}: {
  children: ReactNode;
  separated?: boolean;
}) {
  return (
    <div className="c-dact" data-sep={separated ? "true" : undefined}>
      {children}
    </div>
  );
}

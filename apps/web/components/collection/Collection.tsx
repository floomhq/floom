"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { CollectionConfig, CollectionState } from "@/lib/collection/types";
import {
  parseCollectionState,
  serializeCollectionState,
} from "@/lib/collection/url-state";
import { CollectionView } from "./CollectionView";

/**
 * URL-bound Collection (SPEC §8a/§8b). Holds view state locally, seeded from
 * the URL, and shallow-syncs back via the history API: push when the selection
 * changes (so Back closes/changes the detail), replace for search/tag/view
 * churn (no RSC refetch per keystroke). Back/forward re-seed from the URL.
 */
export function Collection<T>({ config }: { config: CollectionConfig<T> }) {
  return <CollectionInner config={config} />;
}

function CollectionInner<T>({ config }: { config: CollectionConfig<T> }) {
  const searchParams = useSearchParams();
  const defaultView = config.view?.default ?? "list";

  const [state, setState] = useState<CollectionState>(() =>
    parseCollectionState(new URLSearchParams(searchParams.toString()), defaultView),
  );
  // Mirror committed state into a ref so the (stable) handlers below can read
  // the latest value without being recreated on every keystroke.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Back/forward → re-seed from the URL.
  useEffect(() => {
    const onPop = () =>
      setState(parseCollectionState(new URLSearchParams(window.location.search), defaultView));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [defaultView]);

  const onChange = useCallback(
    (next: CollectionState) => {
      const prev = stateRef.current;
      setState(next);
      const qs = serializeCollectionState(next, defaultView).toString();
      const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
      // Selection change is "navigation" → pushState; everything else replaces.
      if (next.sel !== prev.sel) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [defaultView],
  );

  const onInvalidSel = useCallback(
    (id: string) => {
      toast.error("Couldn't open that item; it may have been deleted.");
      const next = { ...stateRef.current, sel: null, tab: null };
      setState(next);
      const qs = serializeCollectionState(next, defaultView).toString();
      window.history.replaceState(
        null,
        "",
        qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
      );
      void id;
    },
    [defaultView],
  );

  return (
    <CollectionView
      config={config}
      state={state}
      onChange={onChange}
      onInvalidSel={onInvalidSel}
    />
  );
}

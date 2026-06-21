/**
 * The Collection model (SPEC §0, §8a).
 *
 * Almost every page in Floom is a Collection: a list/grid of items with a
 * search box, a multi-select tag bar, and a 30/70 split detail. Pages become
 * thin configs of `<Collection>`; this file is the shared type surface.
 */
import type { ReactNode } from "react";

/** Tag families, rendered left→right in this order (SPEC §1, §11). */
export type TagFamilyKey =
  | "smart" // Starred · Recent · Archived (per-collection, opt-in)
  | "status" // derived item state, per collection
  | "trigger" // Runs only: Scheduled · Manual · Webhook (its own family)
  | "type" // Connections only: Connection · MCP · Secret
  | "stage" // Workers only: Draft · Live (maturity label, mess-control)
  | "visibility" // Private · Shared (SPEC §12)
  | "content"; // shared user-label vocabulary

/** Order families render in the bar. */
export const TAG_FAMILY_ORDER: TagFamilyKey[] = [
  "smart",
  "status",
  "trigger",
  "type",
  "stage",
  "visibility",
  "content",
];

export interface TagOption {
  value: string;
  label: string;
  /** Optional count badge (e.g. content tag usage). */
  count?: number;
}

export type TagFamilies = Partial<Record<TagFamilyKey, TagOption[]>>;

/** URL-backed view state shared by every collection (SPEC §8b). */
export interface CollectionState {
  sel: string | null;
  tab: string | null;
  view: ViewMode;
  q: string;
  /** Active tag values per family. Empty/absent family = no filter (show all). */
  tags: Partial<Record<TagFamilyKey, string[]>>;
}

export type ViewMode = "list" | "grid";

/** A status pill descriptor (SPEC §2a — outlined/tinted + leading dot). */
export type PillTone = "ok" | "run" | "err" | "warn" | "pending" | "idle";

export interface StatusPillSpec {
  tone: PillTone;
  label: string;
}

/** One rendered list row (SPEC §2a canonical row). */
export interface ListRowSpec {
  /** Brand logo node or semantic icon. Omit for non-person entities (V4 SPEC rule 3). */
  leading?: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  /** Collection-specific middle columns (between sub and status). */
  cols?: ReactNode[];
  status?: StatusPillSpec | null;
  /** Row action menu items; omit to hide the ⋯ menu. */
  menu?: RowMenuItem[];
}

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** Grid column headers, aligned to ListRowSpec.cols (resting list only). */
export interface ListColumns {
  /** CSS grid-template-columns for the row + header. */
  template: string;
  headers: string[];
  /** When true the header row is transparent (no grey bar), hairline only. */
  headerTransparent?: boolean;
  /** Render the canonical status slot after `cols`; defaults to true. */
  statusColumn?: boolean;
  /** Render the trailing row-actions slot; defaults to true. */
  menuColumn?: boolean;
}

/** One detail tab (SPEC §3). */
export interface DetailTab {
  key: string;
  label: string;
  count?: number;
  render: () => ReactNode;
}

export interface DetailHeader {
  leading: ReactNode;
  title: ReactNode;
  /** Right-aligned primary/secondary actions + overflow. */
  actions?: ReactNode;
  /** Subtitle row (visibility pill, description, app logos). */
  sub?: ReactNode;
}

export interface CollectionStates {
  empty?: {
    title: string;
    help?: string;
    icon?: import("react").ComponentType<{ size?: number }>;
    action?: ReactNode;
    /** Render the empty state as a bounded dashed drop-zone box (drop-led
     *  surfaces such as the Library). */
    dropzone?: boolean;
  };
  errorRetry?: () => void;
}

/**
 * The single config every collection page provides to `<Collection>`.
 * `T` is the item shape (Worker, Run, Connection, …).
 */
export interface CollectionConfig<T> {
  title: string;
  subtitle?: string;
  /**
   * When true the Collection suppresses its own title/subtitle header row.
   * Use this when the parent renders its own heading (e.g. the WorkersCollection
   * tab switcher already labels the "Workers" tab — a second H1 is redundant).
   */
  hideTitle?: boolean;
  /**
   * Optional node rendered immediately below the title header and above the
   * control bar (search + filters). Used for a section tab strip that must be
   * consistent across sibling surfaces (e.g. the Integrations Connected / Browse
   * / MCP / Secrets tabs). Rendered only in the resting list view, not detail.
   */
  headerSlot?: ReactNode;
  items: T[];
  loading?: boolean;
  error?: string | null;

  idOf: (item: T) => string;
  /**
   * Resolve an item that is deep-linked via `?sel=<id>` but absent from the
   * loaded list (which is partial: paged Runs, cache-first/filtered Workers).
   * Called once per missing id; a non-null result is merged into the displayed
   * items so the detail opens — no toast. Only a null result or a throw is a
   * genuine miss and surfaces the "couldn't open" toast. Omit for collections
   * whose list is always complete (they keep the toast-on-miss behavior).
   */
  resolveMissing?: (id: string) => Promise<T | null>;
  /** Free-text fields searched by the search box. */
  searchOf: (item: T) => string;
  /** Optional placeholder override for the shared collection search box. */
  searchPlaceholder?: string;
  /** The tag values an item HAS, per family (compared against active tags). */
  tagsOf?: (item: T) => Partial<Record<TagFamilyKey, string[]>>;

  /** Tag families to render (only families present are shown). */
  tags?: TagFamilies;
  /** Uniform count strip (SPEC §11). */
  counts?: { value: number | string; label: string }[];

  view?: { default?: ViewMode; grid?: boolean };
  columns: ListColumns;
  /** Optional day/section grouping for the resting list (Runs — SPEC §5). */
  group?: (item: T) => string;
  row: (item: T) => ListRowSpec;
  card?: (item: T) => CardSpec;

  detail: (item: T, activeTab?: string) => {
    header: DetailHeader;
    tabs: DetailTab[];
    /**
     * Optional node rendered INSIDE the primary tab row, after the tabs and
     * right-aligned (e.g. an "Advanced ▾" group that exposes secondary tabs).
     * Most collections omit it; the worker detail uses it so the advanced tab
     * group is visibly on the tab row, not buried in the header overflow.
     */
    tabsTrailing?: ReactNode;
  };

  states?: CollectionStates;

  /**
   * +Add button (SPEC §0 control bar). Provide `panel` to open the add flow in
   * the detail pane (SPEC §5); otherwise `onSelect` runs (e.g. navigate).
   */
  add?: {
    label: string;
    onSelect?: () => void;
    panel?: { title: string; render: (close: () => void) => ReactNode };
  };
  /** Extra control-bar actions (e.g. Runs "Export CSV"), left of +Add. */
  toolbarActions?: ReactNode;
  /** Optional banner above the list (e.g. member-visibility note). When a
   *  function, CollectionView passes an `openAdd` callback that opens the +Add
   *  panel — used by Brain's unified drop-zone banner ("+ New folder"). */
  banner?: ReactNode | ((openAdd: () => void) => ReactNode);
  /** Optional footer rendered below the list body (e.g. "Load more" button — B37). */
  footer?: ReactNode;
}

/** Grid card (SPEC §2b — name, 2-line desc, status pill + tool logos). */
export interface CardSpec {
  /** Optional leading element (lock icon when private). Omit for non-person entities (V4 rule 3). */
  leading?: ReactNode;
  name: ReactNode;
  description?: ReactNode;
  status?: StatusPillSpec | null;
  /** ≤3 tiny tool logos in the footer. */
  toolLogos?: ReactNode;
  /** Star toggle (hover only). Omit to hide. */
  star?: { on: boolean; onToggle: () => void };
  /**
   * Optional mini sparkline showing recent run history.
   * Shown on hover in the card footer (#1117).
   * Accepts TimeseriesDay[] (success/fail split) or number[] (totals only).
   */
  sparkline?: ReactNode;
  /**
   * Optional muted metadata line shown between description and footer.
   * E.g. "2h ago · 12 runs · 91%". (#1175)
   */
  meta?: ReactNode;
  /**
   * Optional quick-action buttons shown on hover in the card footer (#1174).
   * Each item has a label and an onClick. Rendered as small text buttons.
   * Use e.stopPropagation() is handled by CollectionGrid.
   */
  quickActions?: Array<{ label: string; onClick: (e: React.MouseEvent) => void }>;
}

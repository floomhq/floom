/**
 * The Collection model (SPEC §0, §8a).
 *
 * Almost every page in Floom is a Collection: a list/grid of items with a
 * search box, a multi-select tag bar, and a 30/70 split detail. Pages become
 * thin configs of `<Collection>`; this file is the shared type surface.
 */
import type { ReactNode } from "react";
import type { ConfirmDialogProps } from "@/components/ui/confirm-dialog";

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
  /** #1208: human-readable explanation of WHY the pill is in this state (e.g.
   *  "Last run failed", "Missing secret: OPENAI_API_KEY"). When present, the
   *  rendered pill becomes a tooltip trigger so the pill is never a dead end.
   *  Optional and collection-specific: most collections leave this unset. */
  reason?: string;
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
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  confirm?: Pick<
    ConfirmDialogProps,
    "title" | "body" | "confirmLabel" | "cancelLabel" | "destructive" | "requireTypedConfirmation"
  >;
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

export type SortDirection = "asc" | "desc";
export type SortValue = string | number | boolean | Date | null | undefined;

export interface CollectionSortState {
  column: number;
  direction: SortDirection;
}

export interface CollectionSortColumn<T> {
  value: (item: T) => SortValue;
  /** Direction used the first time the user clicks this column. Defaults to asc. */
  defaultDirection?: SortDirection;
}

export interface CollectionSortConfig<T> {
  columns: Partial<Record<number, CollectionSortColumn<T>>>;
}

/** A label/value fact — the unit of summary rows, pairs, and key/value rows. */
export interface DetailFact {
  key: string;
  label: ReactNode;
  value: ReactNode;
}

/** A chip in a DetailChips group. String shorthand: a leading "+" → add chip. */
export type DetailChip =
  | string
  | { key: string; label: ReactNode; add?: boolean };

/** One key/value row inside a DetailSection. */
export interface DetailRowSpec {
  key: string;
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

/**
 * A declarative detail section — the engine renders it through DetailKit so
 * every surface looks identical. Compose a summary + grouped rows/pairs/chips
 * + an optional note/actions; `empty` shows when the section resolves to no
 * rows/pairs/chips.
 */
export interface DetailSection {
  key: string;
  label?: ReactNode;
  /** Muted line under the label (c-dctx). */
  context?: ReactNode;
  summary?: DetailFact[];
  pairs?: DetailFact[];
  rows?: DetailRowSpec[];
  chips?: DetailChip[];
  /** Rendered when the section has no rows/pairs/chips. */
  empty?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
}

/**
 * Reasons a tab may opt OUT of the structured register (the escape hatch).
 * Every custom tab must name one — that keeps bespoke UI explicit and
 * review-visible. Structured-by-default: only non-tabular / async-loaded /
 * stateful-editor UI earns a reason here. Anything that is a synchronous
 * key/value or form pane stays structured (summary/sections).
 */
export type CustomTabReason =
  | "worker-flow" // worker Overview: the flow graph + about body (WorkerFlow canvas)
  | "worker-runs" // embedded run-history list (summary + recent-run links)
  | "worker-setup" // nested second-row tab editor (Inputs/Triggers/Limits/Alerts)
  | "version-history" // git-log style version list with diff/restore row actions
  | "brain-editor" // attached-folder editor (WorkerBrainEditor)
  | "file-viewer" // file/code/JSON viewers (FilesEditor, InlineFileOpen, raw JSON blocks)
  | "tool-list" // async-loaded tool/action allowlist panels (search + segmented controls)
  | "used-by" // async reverse-index "which workers use this" list panels
  | "activity-feed" // async run-activity / email-peek feed panels
  | "secret-form" // interactive secret add/replace/delete editor
  | "settings-form" // bespoke settings section forms (channels, members, tokens, danger…)
  | "approval-review" // input-left / proposed-output-right approval review UI
  | "run-output" // run Output viewer (artifacts + metrics strip)
  | "run-inputs" // raw run input JSON viewer
  | "run-logs"; // run Logs stream

interface DetailTabBase {
  key: string;
  label: string;
  count?: number;
}

/**
 * Structured tab: declares its content as DATA; the engine renders it through
 * the register. Must have a non-empty summary OR sections. `render`/`custom`
 * are forbidden — that XOR makes drift a compile error.
 */
export type StructuredDetailTab = DetailTabBase &
  (
    | { summary: [DetailFact, ...DetailFact[]]; sections?: DetailSection[] }
    | { summary?: DetailFact[]; sections: [DetailSection, ...DetailSection[]] }
  ) & {
    render?: never;
    custom?: never;
  };

/**
 * Custom tab: genuinely bespoke UI (graphs, editors, file/log viewers). MUST
 * name a `custom` reason from the allowlist. Structured fields are forbidden.
 */
export interface CustomDetailTab extends DetailTabBase {
  custom: CustomTabReason;
  render: () => ReactNode;
  summary?: never;
  sections?: never;
}

/** One detail tab (SPEC §3): structured-by-default, custom-by-exception. */
export type DetailTab = StructuredDetailTab | CustomDetailTab;

export interface DetailHeader {
  leading: ReactNode;
  title: ReactNode;
  /** Structured status pill, rendered by the engine (SPEC §2a). */
  status?: StatusPillSpec;
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
  filteredEmpty?: {
    title: string;
    help?: string;
    icon?: import("react").ComponentType<{ size?: number }>;
    action?: ReactNode;
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
  /**
   * Optional copy for a genuinely missing deep-linked item. Collections with
   * partial lists can use this to give route-specific feedback after
   * resolveMissing returns null or throws.
   */
  invalidSelectionMessage?: string;
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
  /** Optional shared table sorting. Keys match `columns.headers` indexes. */
  sort?: CollectionSortConfig<T>;
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
  /**
   * Optional maximum width for the resting collection chrome and list. Split
   * detail mode remains full-width so the 30/70 pane can use the available room.
   */
  restingMaxWidth?: number;
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

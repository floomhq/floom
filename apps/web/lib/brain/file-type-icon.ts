/**
 * Shared file-type → Lucide icon mapping for brain context folders.
 *
 * Used by BrainVisual (brain page banner) and the worker-detail overview
 * "Company brain it uses" chips. Keep in sync: one source of truth, no forks.
 */
import type { ComponentType } from "react";
import {
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  Link2,
  type LucideProps,
} from "lucide-react";

export type BrainFileType = "pdf" | "doc" | "md" | "xlsx" | "url" | "png" | "folder" | "other";

export interface BrainFileMeta {
  ext: string;
  Icon: ComponentType<LucideProps>;
  tint: string;
}

export const BRAIN_FILE_META: Record<BrainFileType, BrainFileMeta> = {
  pdf:    { ext: "PDF",  Icon: FileText,        tint: "#D14343" },
  doc:    { ext: "DOC",  Icon: FileText,        tint: "#2563eb" },
  md:     { ext: "MD",   Icon: FileCode,        tint: "#181818" },
  xlsx:   { ext: "XLSX", Icon: FileSpreadsheet, tint: "#0F9D58" },
  url:    { ext: "URL",  Icon: Link2,           tint: "#3a6ea5" },
  png:    { ext: "PNG",  Icon: FileImage,       tint: "#9d6df1" },
  folder: { ext: "DIR",  Icon: Folder,          tint: "#B45309" },
  other:  { ext: "FILE", Icon: FileText,        tint: "#6b7280" },
};

/** Infer file type from a context folder name and optional category. */
export function inferBrainFileType(
  name: string,
  category?: string | null,
): BrainFileType {
  const n = name.toLowerCase();
  const c = (category ?? "").toLowerCase();
  if (n.includes("pdf")  || c.includes("pdf"))                          return "pdf";
  if (n.includes("xls")  || c.includes("xls") || c.includes("spreadsheet")) return "xlsx";
  if (n.includes("md")   || c.includes("markdown") || c.includes("doc"))    return "md";
  if (n.includes("url")  || c.includes("url")  || c.includes("web"))        return "url";
  if (n.includes("img")  || n.includes("png")  || c.includes("image"))      return "png";
  return "folder";
}

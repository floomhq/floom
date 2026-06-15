"use client";

import { useCallback, useState } from "react";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Upload, CheckCircle2, AlertCircle } from "lucide-react";

interface CsvColumnMapperProps {
  /** Required column names from worker.yml csv_required_columns */
  requiredColumns: string[];
  /** Called when user submits the mapped CSV as a string */
  onMapped: (csvString: string) => void;
  /** Input label */
  label?: string;
}

/** Levenshtein distance for fuzzy fallback */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Alias map: canonical field name → all known header variants
 * Covers: English, German, Loxo CRM export defaults
 */
const FIELD_ALIASES: Record<string, string[]> = {
  name: [
    // English
    "fullname", "full name", "contactname", "contact name", "person name",
    "person", "personname",
    // German
    "kandidat", "kandidatenname", "vollstaendigername", "vollstaendiger name",
    // Loxo
    "applicantname", "candidatename",
  ],
  email: [
    // English
    "mail", "emailaddress", "email address", "emailid", "email id",
    "e-mail address", "e-mail-adresse", "emailadresse",
    // German
    "email-adresse", "emai", "emailliste",
    // Loxo
    "primaryemail", "primary email",
  ],
  current_company: [
    // English
    "company", "companyname", "company name", "organization", "organisation",
    "employer", "currentcompany", "current company",
    // German
    "firma", "aktuelle firma", "aktuellesfirma", "unternehmen", "arbeitgeber",
    "aktuelles unternehmen",
    // Loxo
    "currentemployer", "current employer",
  ],
  current_title: [
    // English
    "jobtitle", "job title", "title", "position", "currentrole", "current role",
    "currentjobtitle", "current job title", "currentposition", "current position",
    // German
    "titel", "berufsbezeichnung", "stelle", "rolle", "aktuelle stelle",
    "aktuelle position", "aktueller titel",
    // Loxo
    "jobrole",
  ],
  headline: [
    // English
    "summary", "bio", "about", "tagline", "headline", "profile", "overview",
    // German
    "profil", "zusammenfassung", "kurzbeschreibung",
  ],
  last_active_iso: [
    // English
    "lastactive", "last active", "lastactivity", "last activity", "active",
    "lastcontact", "last contact", "lastmodified", "last modified",
    "lastseen", "last seen",
    // German
    "letzte aktivitat", "letzte aktivität", "letzte aktivitaet", "stand",
    "zuletzt aktiv",
    // Loxo
    "lastactivitydate",
  ],
  skills: [
    // English
    "skill", "skills", "technologies", "tech", "techstack", "tech stack",
    "expertise", "competencies",
    // German
    "technologien", "kompetenzen", "kenntnisse", "faehigkeiten", "fähigkeiten",
    "fertigkeiten",
  ],
  notes: [
    // English
    "note", "notes", "comment", "comments", "remarks", "description",
    // German
    "notizen", "anmerkung", "anmerkungen", "bemerkung", "bemerkungen",
    "beschreibung",
    // Loxo
    "internalnotes", "internal notes",
  ],
};

function fuzzyMatch(csvHeader: string, required: string): number {
  const a = csvHeader.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = required.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;

  // Check alias map (normalized)
  const aliasList = FIELD_ALIASES[required] || [];
  for (const alias of aliasList) {
    const normalizedAlias = alias.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (a === normalizedAlias) return 0.95;
    if (a.includes(normalizedAlias) || normalizedAlias.includes(a)) return 0.7;
  }

  // Levenshtein fallback: score based on similarity ratio
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen > 0) {
    const similarity = 1 - dist / maxLen;
    if (similarity >= 0.7) return similarity * 0.5; // scale down for fuzzy matches
  }

  return 0;
}

function autoDetectMapping(
  csvHeaders: string[],
  requiredCols: string[]
): { mapping: Record<string, string>; autoMapped: number } {
  const mapping: Record<string, string> = {};
  let autoMapped = 0;
  for (const req of requiredCols) {
    let bestHeader = "";
    let bestScore = 0;
    for (const h of csvHeaders) {
      const score = fuzzyMatch(h, req);
      if (score > bestScore) {
        bestScore = score;
        bestHeader = h;
      }
    }
    if (bestScore > 0.4) {
      mapping[req] = bestHeader;
      autoMapped++;
    } else {
      mapping[req] = "";
    }
  }
  return { mapping, autoMapped };
}

export function CsvColumnMapper({ requiredColumns, onMapped, label }: CsvColumnMapperProps) {
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [autoMappedCount, setAutoMappedCount] = useState(0);
  const [fileName, setFileName] = useState<string>("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFile = useCallback((file: File) => {
    setError(null);
    setFileName(file.name);
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete: (result) => {
        const rows = result.data as string[][];
        if (rows.length < 2) {
          setError("CSV must have at least a header row and one data row.");
          return;
        }
        const headers = rows[0];
        setCsvHeaders(headers);
        setCsvRows(rows.slice(1));
        const { mapping: detected, autoMapped } = autoDetectMapping(headers, requiredColumns);
        setMapping(detected);
        setAutoMappedCount(autoMapped);
      },
      error: (err) => {
        setError(`Failed to parse CSV: ${err.message}`);
      },
    });
  }, [requiredColumns]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  }, [loadFile]);

  function handleSubmit() {
    // Remap CSV: for each row, output values in the order of requiredColumns
    const unmapped = requiredColumns.filter((c) => !mapping[c]);
    if (unmapped.length > 0) {
      setError(`Please map all required columns: ${unmapped.join(", ")}`);
      return;
    }
    const header = requiredColumns;
    const rows = csvRows.map((row) =>
      requiredColumns.map((req) => {
        const srcCol = mapping[req];
        const srcIdx = csvHeaders.indexOf(srcCol);
        return srcIdx >= 0 ? row[srcIdx] ?? "" : "";
      })
    );
    const csv = Papa.unparse([header, ...rows]);
    onMapped(csv);
  }

  const allMapped = requiredColumns.every((c) => mapping[c]);

  if (!csvHeaders.length) {
    return (
      <div>
        {label && <p className="text-sm font-medium mb-1.5">{label}</p>}
        <div
          className={`relative rounded-[var(--radius-ui)] p-6 text-center transition-colors cursor-pointer ${
            dragging ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]" : "hover:bg-muted/40"
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => document.getElementById("csv-mapper-input")?.click()}
        >
          <input
            id="csv-mapper-input"
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) loadFile(file);
            }}
          />
          <Upload className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Drop a CRM CSV here or click to browse</p>
          <p className="text-xs text-muted-foreground mt-1">Headers will be auto-detected</p>
        </div>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {label && <p className="text-sm font-medium">{label}</p>}
      <div className="flex items-center gap-2 p-2 rounded bg-muted text-xs text-muted-foreground">
        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
        <span className="font-medium truncate">{fileName}</span>
        <span className="text-muted-foreground">({csvRows.length} rows)</span>
        <button
          className="ml-auto text-muted-foreground hover:text-foreground underline"
          onClick={() => { setCsvHeaders([]); setCsvRows([]); setMapping({}); setAutoMappedCount(0); setFileName(""); setError(null); }}
        >
          Change
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Auto-mapped <span className="font-medium">{autoMappedCount} of {requiredColumns.length}</span> columns
        {autoMappedCount < requiredColumns.length && (
          <span className="text-[var(--ink-soft)]"> ({requiredColumns.length - autoMappedCount} need manual selection)</span>
        )}
      </p>

      <div className=" rounded-[var(--radius-ui)] overflow-hidden">
        <div className="grid grid-cols-2 gap-0 bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground [border-bottom:var(--bd-div)]">
          <span>Required column</span>
          <span>Your CSV column</span>
        </div>
        <div className="[&>*+*]:[border-top:var(--bd-div)]">
          {requiredColumns.map((col) => (
            <div key={col} className="grid grid-cols-2 gap-0 items-center px-4 py-2">
              <span className="text-sm font-mono text-foreground">{col}</span>
              <div className="flex items-center gap-2">
                <Select
                  value={mapping[col] || ""}
                  onValueChange={(val: string | null) => setMapping((prev) => ({ ...prev, [col]: val ?? "" }))}
                >
                  <SelectTrigger className="h-7 text-xs w-full">
                    <SelectValue placeholder="(skip)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">(skip)</SelectItem>
                    {csvHeaders.map((h) => (
                      <SelectItem key={h} value={h}>{h}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {mapping[col] ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <Button
        onClick={handleSubmit}
        disabled={!allMapped}
        size="sm"
        className="w-full"
      >
        Use mapped CSV ({csvRows.length} contacts)
      </Button>
    </div>
  );
}

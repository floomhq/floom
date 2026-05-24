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

function fuzzyMatch(csvHeader: string, required: string): number {
  const a = csvHeader.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = required.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  // Check common aliases
  const aliases: Record<string, string[]> = {
    name: ["fullname", "contactname", "person", "kandidat", "kandidatenname"],
    email: ["mail", "emailaddress", "e-mail", "kontakt"],
    current_company: ["company", "firma", "unternehmen", "arbeitgeber", "organization"],
    current_title: ["jobtitle", "position", "title", "titel", "stelle", "rolle"],
    headline: ["summary", "bio", "about", "profil", "zusammenfassung"],
    last_active_iso: ["lastactive", "lastactivity", "active", "aktiv", "lastcontact"],
    skills: ["skill", "technologien", "technologies", "kompetenzen", "kenntnisse"],
    notes: ["note", "comment", "bemerkung", "notizen", "anmerkung"],
  };
  const aliasList = aliases[b] || [];
  for (const alias of aliasList) {
    if (a.includes(alias) || alias.includes(a)) return 0.6;
  }
  return 0;
}

function autoDetectMapping(
  csvHeaders: string[],
  requiredCols: string[]
): Record<string, string> {
  const mapping: Record<string, string> = {};
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
    mapping[req] = bestScore > 0.5 ? bestHeader : "";
  }
  return mapping;
}

export function CsvColumnMapper({ requiredColumns, onMapped, label }: CsvColumnMapperProps) {
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState<string>("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadFile(file: File) {
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
        setMapping(autoDetectMapping(headers, requiredColumns));
      },
      error: (err) => {
        setError(`Failed to parse CSV: ${err.message}`);
      },
    });
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  }, [requiredColumns]);

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
          className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
            dragging ? "border-black bg-[#f4f4f5]" : "border-[#e4e4e7] hover:border-[#aaa]"
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
          <Upload className="w-6 h-6 text-[#999] mx-auto mb-2" />
          <p className="text-sm text-[#666]">Drop a CRM CSV here or click to browse</p>
          <p className="text-xs text-[#999] mt-1">Headers will be auto-detected</p>
        </div>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {label && <p className="text-sm font-medium">{label}</p>}
      <div className="flex items-center gap-2 p-2 rounded bg-[#f4f4f5] text-xs text-[#666]">
        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
        <span className="font-medium truncate">{fileName}</span>
        <span className="text-[#999]">— {csvRows.length} rows</span>
        <button
          className="ml-auto text-[#999] hover:text-[#333] underline"
          onClick={() => { setCsvHeaders([]); setCsvRows([]); setMapping({}); setFileName(""); setError(null); }}
        >
          Change
        </button>
      </div>

      <div className="border border-[#eaeaea] rounded-lg overflow-hidden">
        <div className="grid grid-cols-2 gap-0 bg-[#f9f9f9] px-4 py-2 text-xs font-medium text-[#666] border-b border-[#eaeaea]">
          <span>Required column</span>
          <span>Your CSV column</span>
        </div>
        <div className="divide-y divide-[#f0f0f0]">
          {requiredColumns.map((col) => (
            <div key={col} className="grid grid-cols-2 gap-0 items-center px-4 py-2">
              <span className="text-sm font-mono text-[#333]">{col}</span>
              <div className="flex items-center gap-2">
                <Select
                  value={mapping[col] || ""}
                  onValueChange={(val: string | null) => setMapping((prev) => ({ ...prev, [col]: val ?? "" }))}
                >
                  <SelectTrigger className="h-7 text-xs border-[#e4e4e7] w-full">
                    <SelectValue placeholder="— skip —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— skip —</SelectItem>
                    {csvHeaders.map((h) => (
                      <SelectItem key={h} value={h}>{h}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {mapping[col] ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
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

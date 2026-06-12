"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface WorkerMetadataValues {
  workerId: string;
  name: string;
  description?: string;
  tags?: string[];
  folder?: string;
}

interface WorkerMetadataFormProps {
  values: WorkerMetadataValues;
  onChange: (updated: WorkerMetadataValues) => void;
  mode: "create" | "edit";
  idError?: string | null;
}

export function WorkerMetadataForm({
  values,
  onChange,
  mode,
  idError,
}: WorkerMetadataFormProps) {
  const isEdit = mode === "edit";

  return (
    <Card className="[border:var(--bd-card)] shadow-none bg-card">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Identity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-sm">
            Worker ID {!isEdit && <span className="text-red-500">*</span>}
          </Label>
          {isEdit ? (
            <div className="rounded-[var(--radius-button)] [border:var(--bd-card)] bg-muted/50 px-3 py-2">
              <span className="text-sm font-mono text-muted-foreground">{values.workerId}</span>
              <p className="text-xs text-muted-foreground mt-0.5">Worker ID cannot be changed after creation.</p>
            </div>
          ) : (
            <>
              <Input
                value={values.workerId}
                onChange={(e) =>
                  onChange({
                    ...values,
                    workerId: e.target.value.toLowerCase().replace(/[\s_]+/g, "-"),
                  })
                }
                className={`[border:var(--bd-card)] font-mono ${idError ? "[border:var(--bd-input)]" : ""}`}
                placeholder="my-worker"
              />
              {idError && <p className="text-xs text-red-500">{idError}</p>}
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm">Name</Label>
          <Input
            value={values.name}
            onChange={(e) => onChange({ ...values, name: e.target.value })}
            className="[border:var(--bd-card)]"
            placeholder="My Worker"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm">Description</Label>
          <Textarea
            value={values.description ?? ""}
            onChange={(e) => onChange({ ...values, description: e.target.value })}
            className="min-h-[60px] [border:var(--bd-card)]"
            placeholder="What does this worker do?"
          />
        </div>
      </CardContent>
    </Card>
  );
}

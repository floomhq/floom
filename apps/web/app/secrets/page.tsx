"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyRound } from "lucide-react";
import type { SecretItem } from "@/lib/types";

export default function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.secrets.list().then((s) => {
      setSecrets(s);
      setLoading(false);
    });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Secrets</h1>
        <p className="text-[#666] text-sm mt-1">Available and missing secrets from your .env file.</p>
      </div>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Environment secrets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)
          ) : secrets.length === 0 ? (
            <p className="text-sm text-[#999]">No secrets configured.</p>
          ) : (
            secrets.map((s) => (
              <div
                key={s.name}
                className="flex items-center justify-between p-3 rounded-md hover:bg-[#f4f4f5] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <KeyRound className="w-4 h-4 text-[#999]" />
                  <div>
                    <p className="text-sm font-medium font-mono">{s.name}</p>
                    {s.used_by.length > 0 && (
                      <p className="text-xs text-[#999]">Used by: {s.used_by.join(", ")}</p>
                    )}
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={
                    s.status === "set"
                      ? "text-emerald-600 border-emerald-200 bg-emerald-50"
                      : "text-red-600 border-red-200 bg-red-50"
                  }
                >
                  {s.status === "set" ? "Set" : "Missing"}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardContent className="p-5 text-sm text-[#666]">
          <p>
            Secret values are read from your <code className="bg-[#f4f4f5] px-1 py-0.5 rounded text-xs">.env</code> file.
            Add secrets there and reload workers to detect changes.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-[#666] text-sm mt-1">Floom configuration.</p>
      </div>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium">About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-[#666]">
          <p>Floom v0 — The OS for Background Workers</p>
          <p>
            Workers are discovered from the <code className="bg-[#f4f4f5] px-1 py-0.5 rounded text-xs">/workers</code>{" "}
            directory. Each worker folder contains a{" "}
            <code className="bg-[#f4f4f5] px-1 py-0.5 rounded text-xs">worker.yml</code> and a{" "}
            <code className="bg-[#f4f4f5] px-1 py-0.5 rounded text-xs">run.py</code>.
          </p>
          <p>
            The backend runs on FastAPI + SQLite. The frontend runs on Next.js + shadcn/ui.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

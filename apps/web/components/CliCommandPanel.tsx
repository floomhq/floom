/* <!-- S15: drop <CliCommandPanel /> into the API access tab after S12 lands --> */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SECRET_STORAGE_KEYS = ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"];
const API_BASE = "https://workers-api.floom.dev";

function readStoredSecret(): string {
  if (typeof window === "undefined") return "";
  for (const key of SECRET_STORAGE_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function maskSecret(secret: string): string {
  if (!secret) return "<YOUR_FLOOM_SECRET>";
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(secret.length - 8)}${secret.slice(-4)}`;
}

export function CliCommandPanel() {
  const [copiedKey, setCopiedKey] = useState("");
  const [storedSecret, setStoredSecret] = useState("");
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setStoredSecret(readStoredSecret());
  }, []);

  const apiSecret = revealed ? (storedSecret || "<YOUR_FLOOM_SECRET>") : maskSecret(storedSecret);

  const snippets = useMemo(
    () => ({
      cli: "npm i -g @floomhq/workeros\nfloom login",
      mcp: "npx @floomhq/workeros install --target claude",
      api: `curl -sS ${API_BASE}/workers \\\n  -H "x-floom-secret: ${apiSecret}"`,
    }),
    [apiSecret]
  );

  async function copySnippet(key: "cli" | "mcp" | "api") {
    await navigator.clipboard.writeText(snippets[key]);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(""), 1200);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Setup commands</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs defaultValue="cli">
          <TabsList>
            <TabsTrigger value="cli">CLI</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
            <TabsTrigger value="api">API</TabsTrigger>
          </TabsList>
          <TabsContent value="cli">
            <SnippetBox
              text={snippets.cli}
              copied={copiedKey === "cli"}
              onCopy={() => void copySnippet("cli")}
            />
          </TabsContent>
          <TabsContent value="mcp">
            <SnippetBox
              text={snippets.mcp}
              copied={copiedKey === "mcp"}
              onCopy={() => void copySnippet("mcp")}
            />
          </TabsContent>
          <TabsContent value="api" className="space-y-2">
            <div className="flex items-center justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setRevealed((value) => !value)}
              >
                {revealed ? <EyeOff className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
                {revealed ? "Hide secret" : "Reveal secret"}
              </Button>
            </div>
            <SnippetBox
              text={snippets.api}
              copied={copiedKey === "api"}
              onCopy={() => void copySnippet("api")}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function SnippetBox({
  text,
  copied,
  onCopy,
}: {
  text: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-2 flex justify-end">
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onCopy}>
          {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="whitespace-pre-wrap text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  );
}

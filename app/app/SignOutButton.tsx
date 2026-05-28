"use client";

import { useState } from "react";
import { API_BASE } from "@/lib/api";

export function SignOutButton() {
  const [loading, setLoading] = useState(false);

  return (
    <button
      type="button"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        try {
          await fetch(`${API_BASE}/auth/logout`, {
            method: "POST",
            credentials: "include",
          });
        } finally {
          window.location.href = "/";
        }
      }}
      style={{
        fontSize: 13,
        background: "#0d0d0d",
        color: "#fff",
        border: "none",
        padding: "8px 14px",
        borderRadius: 8,
        cursor: loading ? "wait" : "pointer",
        fontFamily: "inherit",
        opacity: loading ? 0.7 : 1,
      }}
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}

import type { Config } from "tailwindcss";

const config = {
  theme: {
    extend: {
      colors: {
        "bg-app": "var(--bg-app)",
        "bg-card": "var(--bg-card)",
        "text-primary": "var(--text-primary)",
        "text-muted": "var(--text-muted)",
        "border-default": "var(--border-default)",
        "border-soft": "var(--border-soft)",
        primary: "var(--primary)",
        "primary-text": "var(--primary-text)",
        warning: "var(--warning)",
        success: "var(--success)",
        "active-nav-bg": "var(--active-nav-bg)",
      },
      borderRadius: {
        card: "var(--radius-card)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
      },
    },
  },
} satisfies Config;

export default config;

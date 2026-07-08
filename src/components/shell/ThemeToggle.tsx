"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="flex size-8 items-center justify-center rounded-md border border-line text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
    >
      {mounted ? <Icon name={isDark ? "sun" : "moon"} className="size-4" /> : <span className="size-4" />}
    </button>
  );
}

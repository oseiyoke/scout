import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

function preferredTheme(): Theme {
  const saved = localStorage.getItem("scout-theme");
  if (saved === "light" || saved === "dark") return saved;
  return "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function initializeTheme() {
  applyTheme(preferredTheme());
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(preferredTheme);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("scout-theme", theme);
  }, [theme]);

  const setTheme = (next: Theme) => setThemeState(next);
  const toggleTheme = () => setThemeState((current) => (current === "dark" ? "light" : "dark"));

  return { theme, setTheme, toggleTheme };
}

import { Link, Outlet } from "@tanstack/react-router";
import { Activity, GitBranch, ListTree, Menu, Moon, Sun, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/web/components/ui/button";
import { useEscapeKey } from "@/web/lib/use-escape-key";
import { useMediaQuery } from "@/web/lib/use-media-query";
import { cn } from "@/web/lib/utils";

const NAV = [
  { to: "/", label: "Runs", icon: ListTree },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/dispatch", label: "Dispatch", icon: GitBranch },
] as const;

function NavItems({ onNavigate }: { readonly onNavigate?: () => void }) {
  return (
    <ul className="grid gap-0.5">
      {NAV.map(({ to, label, icon: Icon }) => (
        <li key={to}>
          <Link
            to={to}
            activeOptions={{ exact: to === "/" }}
            onClick={onNavigate}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            activeProps={{ className: "bg-accent text-foreground" }}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const THEME_KEY = "factory-theme";

function readStoredTheme(): "dark" | "light" {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage unavailable (private mode, SSR) — fall through to the default.
  }
  return "dark";
}

/** Persists the choice (D-less POC decision: default dark, not `prefers-color-scheme`). */
function useTheme() {
  const [dark, setDark] = useState(() => readStoredTheme() === "dark");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch {
      // Best-effort persistence only.
    }
  }, [dark]);
  return { dark, toggle: () => setDark((value) => !value) };
}

const NAV_COMPACT_QUERY = "(max-width: 939px)";

/**
 * The shell: a 56px top bar over [nav | page | inspector], separated by
 * hairline borders rather than floating cards. `data-testid="app-shell"` is
 * the playwright smoke test's proof that React mounted (not the retired
 * static viewer). Below 940px the nav becomes a hamburger-driven slide-over
 * with a backdrop and Escape-to-close, matching the prototype.
 */
export function AppShell() {
  const { dark, toggle } = useTheme();
  const navCompact = useMediaQuery(NAV_COMPACT_QUERY);
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  useEscapeKey(navOpen, closeNav);

  return (
    <div data-testid="app-shell" className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        {navCompact ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((value) => !value)}
          >
            <Menu />
          </Button>
        ) : null}
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-full bg-primary font-mono text-sm font-semibold text-primary-foreground">
            f
          </span>
          <span className="font-mono text-lg font-semibold tracking-tight">factory</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-sm text-muted-foreground sm:flex">
            <Activity className="size-4" />
            same-origin API
          </span>
          <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={toggle}>
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {navCompact ? (
          <>
            {navOpen ? (
              <div
                className="fixed top-14 right-0 bottom-0 left-0 z-40 bg-black/40"
                onClick={closeNav}
                aria-hidden="true"
              />
            ) : null}
            <nav
              className={cn(
                "fixed top-14 bottom-0 left-0 z-50 w-64 border-r border-border bg-card p-2.5 shadow-lg transition-transform duration-200",
                navOpen ? "translate-x-0" : "-translate-x-full",
              )}
            >
              <p className="px-2.5 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Monitor
              </p>
              <NavItems onNavigate={closeNav} />
            </nav>
          </>
        ) : (
          <nav className="w-52 shrink-0 border-r border-border p-2.5">
            <p className="px-2.5 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Monitor
            </p>
            <NavItems />
          </nav>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

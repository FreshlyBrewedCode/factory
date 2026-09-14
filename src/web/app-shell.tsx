import { Link, Outlet } from "@tanstack/react-router";
import { Activity, GitBranch, ListTree, Moon, Sun, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/web/components/ui/button";

const NAV = [
  { to: "/", label: "Runs", icon: ListTree },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/dispatch", label: "Dispatch", icon: GitBranch },
] as const;

function NavItems() {
  return (
    <ul className="grid gap-0.5">
      {NAV.map(({ to, label, icon: Icon }) => (
        <li key={to}>
          <Link
            to={to}
            activeOptions={{ exact: to === "/" }}
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

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return { dark, toggle: () => setDark((value) => !value) };
}

/**
 * The shell: a 56px top bar over [nav | page | inspector], separated by
 * hairline borders rather than floating cards. `data-testid="app-shell"` is
 * the playwright smoke test's proof that React mounted (not the retired
 * static viewer).
 */
export function AppShell() {
  const { dark, toggle } = useTheme();

  return (
    <div data-testid="app-shell" className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
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
        <nav className="hidden w-52 shrink-0 border-r border-border p-2.5 md:block">
          <p className="px-2.5 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Monitor
          </p>
          <NavItems />
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <nav className="border-b border-border p-2 md:hidden">
            <NavItems />
          </nav>
          <main className="min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

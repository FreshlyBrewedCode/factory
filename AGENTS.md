factory

- this is a greenfield POC project
- elevator pitch:
  - a copy of mattpocock/sandcastle (https://raw.githubusercontent.com/mattpocock/sandcastle/refs/heads/main/README.md) but using @tanstack/ai (see tanstack-ai skill) and using a lightweight server + web ui with automatic run/dispatch (see ../wayful/scripts/dispatch-ready-issues.sh) and run monitoring
  - three columns
    1. imperative typescript workflows (plain async control flow over a sandbox handle, like sandcastle)
    2. responsive web ui SPA for monitoring
    3. server/daemon that handles lifecycle and automatic dispatch

- suggested stack
  - bun all the way (consider buns bundler (https://bun.com/docs/bundler/fullstack) during POC phase instead of e.g. vite)
  - bun test
  - oxfmt, oxlint, type aware: true, effect lint rules (https://effect.website/docs/v4/getting-started/devtools#oxlint)
  - Effect TS v4 for serverside, owns lifecycle/dispatch/persistence (workflow authoring stays plain async TS, the runtime bridges the two)
    - sqlite for persistence
  - tanstack/ai for the ai/agent runtime using their harness agents and sandboxes (https://raw.githubusercontent.com/tanstack/ai/main/docs/sandbox/overview.md), main adapter to start with is Opencode
    - their workspaces cover clone + bootstrap only, git write-back (branch/commit/push/PR) is ours
  - Web UI, React SPA, tanstack router and query, shadcn, tailwind

- We build in iterrations, it is encouraged to first prototype -> validate -> harden architecture, stack should still be respected during prototyping unless good reasons come up

- Read `STATUS.md` to understand the current status at the end of the session, consider updating `STATUS.md` using /handoff

- If significant changes/decisions have been made that go against the foundation established above, consider updating `AGENTS.md` in the same style. Always confirm these changes with the user.

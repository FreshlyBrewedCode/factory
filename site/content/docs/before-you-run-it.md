---
title: Before you run it
description: What factory is honest about not being, yet.
order: 7
---

Factory is a proof of concept, and it's honest about what it is not.

- **There's no sandbox isolation.** Agents run as your user, on your machine, with your `gh`,
  Claude and opencode credentials, in a clone of your repository. Every permission an agent asks
  for is granted, including writes outside the working tree. Point it at repositories and issues
  you trust.
- **Workflow inputs reach the agent's prompt.** Anyone who can reach the daemon can start a run, so
  don't expose the port beyond your machine, and never interpolate an input straight into
  `ctx.exec`.
- **It needs your machine's logins.** There's no credential injection yet: `gh` and the agents
  you use (a Claude login, or `opencode` with a provider) must be authenticated on the host.
  Your own agent settings stay out of runs by default (`agent.hostSettings`), but your shell
  setup doesn't: Claude Code sources a snapshot of your login shell before each command.

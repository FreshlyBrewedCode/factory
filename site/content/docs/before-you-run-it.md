---
title: Before you run it
description: What factory is honest about not being, yet.
order: 7
---

Factory is a proof of concept, and it's honest about what it is not.

- **There's no sandbox isolation.** Agents run as your user, on your machine, with your `gh` and
  `opencode` credentials, in a clone of your repository. Point it at repositories and issues you
  trust.
- **Workflow inputs reach the agent's prompt.** Anyone who can reach the daemon can start a run, so
  don't expose the port beyond your machine, and never interpolate an input straight into
  `ctx.exec`.
- **It needs your machine's logins.** There's no credential injection yet: `opencode` and `gh`
  must be authenticated on the host.

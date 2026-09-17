---
name: issue-tracker
description: "Docs for the issue tracker conventions. Use if the user mentions keywords like: tracker, epic, subtask, issue, bug, etc."
---

Never put something on the issue tracker without user consent. You can and should propose where applicable.

We use issues in two ways:
- Concrete specification of a TODO item -> the work is ready and just needs to be done
- Evolving context/docs/handoff for planned or ongoing work

- Prefer creating or editing an issue instead of writing a random markdown file
- Not everything needs to go in the issue tracker. We can investigate a bug, fix it, ship the PR in one go without ever creating an issue
- The fewer issues in the tracker, the shorter the lifetime of each issue, the better
- Reasons/triggers to put something in the tracker:
  - you brainstormed, investigated, planned, decided, or specified but did not implement yet
  - user asked to handoff work

We use the following issue types to manage and track work:

# task

A single, self contained piece of work. 
If it can ship as a single PR, it is a task. 
Task is complete if the PR merges.

# epic

A bigger unit of work. Usually the unit in which we brainstrom, plan and specify. 
From there we break it down into tasks. 
Related tasks become subtasks of the epic. 
The epic closes if all subtasks are complete

# tracker

A hub where we put rough, high level ideas and directions in which we want to go.
We heavily rely on linking to other issues and put them into context
Can evolve over time but should stay lean and not over-specified -> link to other issues/ADRs/etc. instead
Gives extended context and ensures we steering in the right direction:
"Long term we want to achieve X, therefore we decided to do go with solution Y in issue #Z"

# bug

In theory, we never have bugs in the tracker. 
If we assume bugs are small we investigate -> fix -> PR in one go as soon as they come up.
If the problem is bigger and requires bigger changes, we go through the normal tracker/epic/task channels
We may explicitly track bugs if
- we have a bug report but did not tackle them yet
- we need to handoff during or after the investigation

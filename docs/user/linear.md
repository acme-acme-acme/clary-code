# Linear

Otter Code shows the Linear issues a thread works on, with their current status. With Otter Connect
you can also delegate a Linear issue to the Otter agent, and it starts a thread on your machine.

## Linked issues

A thread can link one or more Linear issues. Linked issues appear beside the thread in the sidebar.
Click the badge to open the thread's **Linear issues** panel, where you can open or unlink an
issue. On mobile, they appear on the thread row and in the thread's Git sheet.

- Link an issue from the command palette with **Link Linear issue to thread**, using an identifier such as
  `ENG-123` or the issue's URL.
- Agents link the issue they are working on when you name one.
- Issues delegated from Linear are linked automatically.

To show each issue's status, title, and assignee, add a Linear personal API key in
**Settings → Integrations → Linear**. Create the key in Linear under **Settings → Security &
access**. The key stays on the machine running Otter Code, and status refreshes about once a
minute. Without a key, links show only the identifier.

## Delegate issues to Otter

1. Sign in to Otter Connect in **Settings → Connections**, and turn on Otter Connect for the machine
   that should run the work.
2. A Linear workspace admin chooses **Install in a Linear workspace** under **Settings →
   Connections → Linear agent**. This adds the Otter agent to the workspace. Do this once per
   workspace.
3. Each person who delegates issues chooses **Link Linear account** and picks the machine their
   issues run on.
4. On that machine, choose the project issues run in under **Settings → Integrations → Linear**:
   a default project, and optionally a project per Linear team.

Then assign an issue to Otter in Linear. Otter Code starts a thread in a new worktree using
the project's default model and permission mode, and moves the issue to your team's first
"started" status. It also adds an **Open in Otter Code** link to the issue. Follow and steer the
thread from Otter Code on any device.

Things to know:

- The machine must be online with Otter Connect on when you delegate. If it is not, Otter replies
  in Linear with the reason. Delegate the issue again once the machine is back.
- Replies and stop requests sent from Linear do not reach the thread yet. Continue in Otter Code.
- Issues delegated by Linear automations, rather than by a person, are not supported.

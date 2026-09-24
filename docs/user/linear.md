# Linear

Otter Code shows the Linear issues a thread works on, with their current status. With Otter Connect
you can also delegate a Linear issue to the Otter agent, and it starts a thread on your machine.

## Linked issues

A thread can link one or more Linear issues. Linked issues appear beside the thread in the sidebar.
Click the badge to open the issue's page beside the thread, or the thread's **Linear issues** list
when it has several. You can also open the list from the panel's **+** menu. The issue page shows
the issue's state, details, description, links such as its pull requests, and its activity:
comments and changes. It updates while it's open. Select text in its description or a comment and
choose **Cite in composer** to quote it in the thread's composer, the same way as quoting a
response. Cmd-click (Ctrl-click on Windows and Linux) opens an issue in Linear instead. On mobile, they appear on the thread row and in the thread's Git sheet.

- Link an issue from the command palette with **Link Linear issue to thread**, using an identifier such as
  `ENG-123` or the issue's URL.
- Agents link the issue they are working on when you name one.
- Issues delegated from Linear are linked automatically.

To show each issue's status and its page, Otter Code reads Linear in one of two ways:

- **Your Linear account (recommended):** with Otter Connect, choose **Link Linear account** under
  **Settings → Connections → Linear**. Every machine linked to your Otter account then reads
  Linear as you. This also shows each linked pull request's review in Linear: a **Review** button on
  the issue page, and Cmd-Shift-click (Ctrl-Shift-click on Windows and Linux) on a linked issue.
- **A personal API key:** add one under **Settings → Connections → Linear**, created in Linear under
  **Settings → Security & access**. Pick the machine it's for; the key stays on that machine. Reviews
  aren't available with a key.

Changes made in Linear show up within a second or two, both in the status and on an open issue
page. Without either, links show only the identifier.

## Delegate issues to Otter

1. Sign in to Otter Connect in **Settings → Connections**, and turn on Otter Connect for the machine
   that should run the work.
2. A Linear workspace admin chooses **Install agent** under **Settings → Connections → Linear**. This adds the Otter agent to the workspace. Do this once per
   workspace.
3. Each person who delegates issues chooses **Link Linear account**, then picks the machine their
   issues run on next to the linked workspace.
4. Choose the project issues run in on that machine: a default project, and optionally a project
   per Linear team. Expand the linked workspace in **Settings → Connections → Linear** to set them;
   they are saved on its machine. Projects set on any other machine are not used.
5. Optionally, change the **Prompt** in the same place. It is the thread's first
   message and takes the same placeholders as Linear's own prompt templates:
   `{{issue.identifier}}`, `{{issue.branchName}}`, and `{{context}}` (the issue, its comments, and
   your workspace's agent guidance), plus `{{issue.title}}` and `{{issue.url}}`. Your personal
   template in Linear can't be read by Otter Code, so paste it here to use it.

Then assign an issue to Otter in Linear. Otter Code starts a thread in a new worktree on the
issue's Linear branch name (with a numeric suffix if that branch already exists), using the
project's default model and permission mode, and moves the issue to your team's first
"started" status. It also adds an **Open in Otter Code** link to the issue, which opens the thread
in the desktop app when it's installed, and in the browser otherwise. Follow and steer the thread
from Otter Code on any device, or from Linear:

- The Linear session shows the thread's progress: its messages, the commands it runs, the files it
  edits, and its final answer. Questions and approvals appear there too, but you answer them in
  Otter Code.
- A reply in the Linear session is sent to the thread, like a message typed in Otter Code. Stop
  in Linear stops the thread.

Things to know:

- The machine must be online with Otter Connect on when you delegate or reply. If it is not, Otter
  replies in Linear with the reason. Delegate the issue again once the machine is back.
- Progress made while the machine's Otter Code server is restarting doesn't appear in Linear.
- Issues delegated by Linear automations, rather than by a person, are not supported.

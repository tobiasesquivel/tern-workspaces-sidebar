# workspaces-sidebar

A sidebar for Tern that lists every session as a workspace, its tabs underneath, the git
counters of each checkout, and the state of the agent running in each tab. It works like
herdr's workspaces and aside: one row per workspace, its tabs nested, and the agent's state
on the row. A small runtime next to it gives omp, Claude Code and Codex the same agent
commands herdr has (`list`, `get`, `read`, `wait`, `prompt`, `start`).

## Install

Tern is required, and it is in closed beta. This plugin is tested against builds 0.8.2 and
0.8.3. The agent runtime needs Node.js on `PATH` (tested with Node 26).

```sh
tern plugin install github.com/tobiasesquivel/tern-workspaces-sidebar
```

To run the source instead, clone it and link that folder:

```sh
git clone https://github.com/tobiasesquivel/tern-workspaces-sidebar ~/src/tern-workspaces-sidebar
tern plugin link ~/src/tern-workspaces-sidebar
tern plugin reload
```

Either way, `tern plugin list` shows the plugin as `ready`, and the sidebar appears in the tab
you are on. A linked copy reads the source in place, so an edit shows up on the next
`tern plugin reload`; an installed copy is a normal plugin folder under Tern's plugins
directory.

## Using the sidebar

The sidebar is a canvas pane on the left of the tab. It draws one row per session and one row
per tab under it, with the working directory and the branch counters. A click on a session row
folds it. The `...` button on the row, or a double click, opens its menu: open the workspace,
rename it, close the group, and the worktree actions.

To hide or show the sidebar, use the `Hide` badge at its bottom, the key `Ctrl+Alt+B`, or the
`Workspaces: toggle sidebar` command in the palette. For another key, add it to `keybinds` in
`%APPDATA%\Tern\settings.json`.

## Badges

| Badge | Meaning |
| --- | --- |
| `◐` | the agent in that tab is working |
| `?` | the agent is waiting for you, for a permission or for an answer |
| `✓` | the agent finished its turn in a tab you have not looked at yet. Cyan: it ended well |
| `!` | a failure you have not seen: a command or a program that exited non-zero |
| `↑2` `↓5` | commits ahead of, and behind, the upstream branch |
| `user` icon | the pane runs an agent |

An idle agent shows nothing. A `✓` is a finished turn in a tab you have not looked at; it
clears when you focus that pane or its tab, and never because something read the agent's state.
A tab that holds more than one agent can carry both facts at once, and then the `!` is the one
you see: a failure never reads as a finished turn. When a pane has an agent, the state the
agent runtime reports decides the badge. The pane's own busy, running and exit flags only apply
to panes with no agent.

On a workspace row the badges count its tabs: `2?` two agents waiting for you, `1◐` one
working, `1✓` one finished turn nobody has seen.

## Agent runtime

The badges come from a small daemon (`runtime/`, Node) that keeps one state per agent pane. It
starts on its own the first time the sidebar needs it, keeps its files outside Tern's config
(`%LOCALAPPDATA%\tern-agent-runtime\<hash>`, `~/Library/Application Support/...` on macOS,
`$XDG_DATA_HOME/...` on Linux) and stops with nothing to clean up. Each agent reports through
its own connector: omp through an extension, Claude Code and Codex through hooks the launcher
passes on their command line. Nothing is written to your agents' own configuration, and nothing
is approved on your behalf.

States: `working`, `blocked` (a question or a permission, with its reason), `idle`, `done` (a
finished turn you have not looked at) and `unknown`. The CLI speaks the same JSON as herdr's
agent commands:

```sh
node runtime/cli.mjs start scout --kind claude --pane <pane id>   # also omp, codex
node runtime/cli.mjs prompt scout "run the tests" --wait
node runtime/cli.mjs wait scout                                   # idle, done or blocked
node runtime/cli.mjs list
node runtime/cli.mjs get scout
node runtime/cli.mjs read scout --lines 40
```

`start` launches the agent in an existing pane and answers once it is ready for input, or
`agent_not_ready` with the reason when a startup dialog (folder trust, an update prompt, a hooks
review) is waiting for you. `prompt` refuses a blocked agent before typing anything, and with
`--wait` it answers `agent_prompt_stalled` when the prompt changes nothing within 5 seconds.
`list`, `get` and `read` never mark a finished turn as seen. When the agent exits, its name,
state and resume command are released; while it runs, `get` shows the command that resumes its
session (`omp --resume=...`, `claude --resume <id>`, `codex resume <id>`).

## Notification sounds

Two chimes, one per edge, the same ones herdr plays:

| Sound | When |
| --- | --- |
| `done` | the agent in a tab you are not looking at finished its turn |
| `request` | the agent is asking you something: a permission, or an answer |

A first sighting of a pane, a state repeated, and an agent that exits are all silent. An agent
in the tab you are on never chimes when it finishes: Tern reports no window focus, so "you are
looking at it" is the tab you are on, and a tab in a background window counts as one you are
looking at. A question is the one thing that sounds wherever you are. When two chimes come in
the same moment, the request is the one that plays.

The badge and the chime are the same observation: the sidebar keeps one state per pane and
judges the chime when that state moves, so the `?` never appears before the sound, and the chime
does not wait for a repaint or for the sidebar to be open. The player itself is started by the
agent runtime, outside the window: starting a process from a Tern hook can take longer than the
hook may run, and that would freeze the sidebar.

The two files are `sounds/done.mp3` and `sounds/request.mp3` inside the plugin folder; replace
them with your own mp3s under the same names to change the sounds. To mute them, run
`Workspaces: toggle notification sounds` in the palette. macOS plays through `afplay`, Windows
through the bundled `scripts/play.vbs` (MediaPlayer, hidden). Linux is not implemented, so
there the chimes are silent.

The two mp3s and the Windows player (`scripts/play.ps1`) are herdr's
(`github.com/herdrdev/herdr`), under the Apache License 2.0; the license text ships with them
in [`sounds/LICENSE`](sounds/LICENSE).

## Worktrees

When the working directory of a session is a git checkout, the sidebar labels it, and its menu
creates, opens and deletes worktrees. A new checkout lands next to the repository, as
`<repo>-<branch-leaf>`. Deleting a worktree never deletes the branch. The sidebar finds each
checkout and its branch by reading the files git keeps (`.git`, `commondir`, `HEAD`), as herdr
does, so it runs no git process while you work; only the worktree actions do.

## Known limits

- Tern gives each client its own pane ids: a pane the window did not create can have one id in
  the CLI (`tern ls`, `TERN_PANE`) and another inside the window. The sidebar translates
  between the two, so pass the CLI's id to `start`.
- In some tabs Tern lists the tab but cannot report its layout (seen with tabs another client
  created). The sidebar leaves such a tab alone instead of mounting in it.
- Tern disables a plugin hook that runs past its time budget until the next
  `tern plugin reload`. The sidebar keeps its periodic hooks free of process starts except for
  rare ones (starting the runtime, and playing a sound while no runtime is up), and on a
  heavily loaded machine one of those can still run long.
- Only omp, Claude Code and Codex report states. Codex runs with its hooks passed as `-c`
  overrides, which makes it skip its shared background server for that session.

## License

MIT. See `LICENSE`.

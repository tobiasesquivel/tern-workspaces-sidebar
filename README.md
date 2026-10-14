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
`%APPDATA%\Tern\settings.json`. The `Hide` and `+ Workspace` badges ignore a click that comes
less than a second after a click that switched tabs or folded a row: that is the second click
of a double click, landing where the rows moved.

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
`$XDG_DATA_HOME/...` on Linux) and stops with nothing to clean up. Where each state comes from
follows herdr:

- **omp** reports its whole lifecycle through an extension the launcher loads.
- **Claude Code** is read off its screen. The daemon reads every Claude pane, the ones `start`
  launched and the ones you opened by hand, with herdr's own detection rules (the
  `agent-detection` manifests, bundled in `runtime/connectors/manifests/`; a newer copy in
  herdr's cache on the machine wins). Claude's hooks only bring its session (for `resume`) and
  the text of a question or a permission, never a state.
- **Codex** reports its turns through hooks (`UserPromptSubmit` → working, `Stop` and
  `Interrupt` → idle), and its screen decides the rest: a dialog on screen is `blocked` even
  while the hook says working, and before the first hook the screen is all there is.

The daemon reads screens through `tern capture` and processes through `tern process`, one of
each at a time: about every 300 ms while an agent works, every second while it rests, at once
when its title changes. An agent that appears waits 3 seconds before its first read, as in
herdr. Nothing is written to your agents' own configuration, and nothing is approved on your
behalf.

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

`start` launches the agent in an existing pane and answers once it is ready for input (its
prompt on screen), or `agent_not_ready` with the reason when a startup dialog (folder trust, an
update prompt, Codex's sandbox setup, omp's first-run setup) is waiting for you. `prompt` refuses a blocked agent before typing anything, and with
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

A first sighting of a pane, a state repeated, a launch, and an agent that exits are all silent.
An agent in the tab you are on never chimes when it finishes: Tern reports no window focus, so
"you are looking at it" is the tab you are on, and a tab in a background window counts as one
you are looking at. A question is the one thing that sounds wherever you are.

As in herdr, a sound waits one second and plays only if the agent is still in the state that
earned it: a question answered within the second, or a turn that starts again, stays silent.
The agent runtime plays them: it sees every state change, and it starts the player outside the
window, where a process start cannot freeze the sidebar.

The two files are `sounds/done.mp3` and `sounds/request.mp3` inside the plugin folder; replace
them with your own mp3s under the same names to change the sounds. To mute them, run
`Workspaces: toggle notification sounds` in the palette. macOS plays through `afplay`, Windows
through the bundled `scripts/play.vbs` (MediaPlayer, hidden). Linux is not implemented, so
there the chimes are silent.

The two mp3s, the Windows player (`scripts/play.ps1`) and the detection manifests
(`runtime/connectors/manifests/claude.toml` and `codex.toml`) are herdr's
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
- Tern focuses a pane on the press, before the plugin hears the click, and a canvas has no
  option to stay out of the focus (`canvas:open` takes only `title`, `about`, `view`, `md`,
  `dock`, `how` and `focus`, and `focus` only applies to the open). The sidebar hands the
  keyboard back to the tab's terminal in the same event, before the next frame, and titles
  the tab after its terminal meanwhile. What stays visible is Tern's focus line moving to the
  sidebar and back on each press. A key typed in the same frame as a click that switches tabs
  (under 8 ms) reaches the terminal of the tab the click came from.
- Only omp, Claude Code and Codex report states. Codex runs with its hooks passed as `-c`
  overrides, which makes it skip its shared background server for that session.
- Tern tells the runtime when a pane's title changes but not when its output does, so a
  resting agent's screen is read once a second (herdr reads it only after new output). Each
  read is a `tern capture` process, about 200 ms on a Windows machine.
- `start` takes omp as ready when its own prompt line (`π > …` above `╰─`) is on screen. A
  status line configured away from that shape keeps `start` waiting until its timeout.

## License

MIT. See `LICENSE`.

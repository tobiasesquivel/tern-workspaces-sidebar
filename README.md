# workspaces-sidebar

A sidebar for Tern that lists every session as a workspace, its tabs underneath, the git
counters of each checkout, and the state of the agent running in each tab. It works like
herdr's workspaces and aside: one row per workspace, its tabs nested, and the agent's state
on the row.

## Install

Tern is required, and it is in closed beta. This plugin is tested against build 0.8.2.

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

An idle agent shows nothing. A `✓` is a finished turn in a tab you have not looked at: it
clears when you focus that tab, because the flag behind it is Tern's own unseen alert — the same
edge the `done` chime is played from. A `!` is what that flag means when something really
failed. A tab that holds more than one agent can carry both facts at once, and then the `!` is
the one you see: a failure never reads as a finished turn. When a pane has an agent, the state
the agent reports decides the badge. The pane's own busy and running flags only apply to panes
with no agent.

On a workspace row the badges count its tabs: `2?` two agents waiting for you, `1◐` one
working, `1✓` one finished turn nobody has seen.

## Notification sounds

Two chimes, one per edge, the same ones herdr plays:

| Sound | When |
| --- | --- |
| `done` | the agent in a tab you are not looking at finished its turn |
| `request` | the agent is asking you something: a permission, or an answer |

A first sighting of a pane, a state repeated, and an agent that exits are all silent. An agent
in the tab you are on never chimes when it finishes: Tern reports no window focus, so "you are
looking at it" is the tab you are on, and a tab in a background window counts as one you are
looking at. A question is the one thing that sounds wherever you are.

The badge and the chime are the same observation: the sidebar keeps one state per pane, polls
it once per read tick, and plays the question in the same tick that sees it — while the repaint
only draws that cached state. So the `?` can never appear before the sound, the `✓` you clear
by focusing its tab is the same edge the `done` chime played, the chime does not
wait for a repaint (or for the sidebar to be open at all), and a snapshot whose agent read
fails keeps the last state instead of reading as "no agents", which delays a chime to the next
successful read rather than losing it. When two chimes wait for the same tick, the request is
the one that plays.

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
`<repo>-<branch-leaf>`. Deleting a worktree never deletes the branch.

## License

MIT. See `LICENSE`.

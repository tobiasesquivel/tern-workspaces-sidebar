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
| `!` | an alert you have not seen. A finished turn counts as one |
| `↑2` `↓5` | commits ahead of, and behind, the upstream branch |
| `user` icon | the pane runs an agent |

An idle agent shows nothing. When a pane has an agent, the state the agent reports decides the
badge. The pane's own busy and running flags only apply to panes with no agent.

## Worktrees

When the working directory of a session is a git checkout, the sidebar labels it, and its menu
creates, opens and deletes worktrees. A new checkout lands next to the repository, as
`<repo>-<branch-leaf>`. Deleting a worktree never deletes the branch.

## License

MIT. See `LICENSE`.

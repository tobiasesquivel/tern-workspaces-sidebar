--!strict
-- Sidebar pane ownership, memoized reads, health logic (dedup, auto-close, tab flags).

local TITLE = "Workspaces"

local worktrees = require("./worktrees")
local git = require("./git")
local group = require("./group")

local model = {}

-- Per-cycle cache; window.luau invalidates at each cycle start / mutation
local cache_panes: { number } = {}
local cache_valid = false

function model.invalidate()
	cache_valid = false
end

-- One canvas:list per cycle; every is_mine/tab_has_sidebar call hits the cache
function model.mine(cx: WindowCx): { number }
	if cache_valid then
		return cache_panes
	end
	local out = {}
	for _, c in cx.canvas:list() do
		if c.owner == tern.plugin.id and c.title == TITLE then
			if cx.session:pane(c.pane) ~= nil then
				table.insert(out, c.pane)
			end
		end
	end
	cache_panes = out
	return out
end

function model.is_mine(cx: WindowCx, pane_id: number): boolean
	for _, p in model.mine(cx) do
		if p == pane_id then
			return true
		end
	end
	return false
end

-- Checks canvas list AND the tab layout tree (prevents duplicate opens on race)
function model.tab_has_sidebar(cx: WindowCx, tab_id: number): (boolean, number?)
	for _, pane in model.mine(cx) do
		if cx.session:tab_of(pane) == tab_id then
			return true, pane
		end
	end

	local l = cx.session:layout(tab_id)
	if l and l.root then
		local function scan(tree: any): number?
			if not tree then
				return nil
			end
			if tree.pane then
				local pinfo = cx.session:pane(tree.pane)
				if pinfo and (pinfo.title == TITLE or model.is_mine(cx, tree.pane)) then
					return tree.pane
				end
			end
			return scan(tree[1]) or scan(tree[2])
		end
		local found = scan(l.root)
		if found then
			return true, found
		end
	end

	return false, nil
end

-- Closes accidental duplicate sidebar panes in the same tab
function model.deduplicate_sidebars(cx: WindowCx)
	local seen_tab: { [number]: number } = {}
	for _, pane in model.mine(cx) do
		local tab = cx.session:tab_of(pane)
		if tab then
			if seen_tab[tab] then
				cx.layout:close(pane)
				model.invalidate()
			else
				seen_tab[tab] = pane
			end
		end
	end
end

-- Ctrl+D support: a tab holding ONLY the sidebar gets it closed, so Tern closes the tab.
-- Toggleable via kv "auto_close_empty_tabs" (default ON).
function model.auto_close_empty_tabs(cx: WindowCx)
	local enabled = tern.kv.get("auto_close_empty_tabs")
	if enabled == false then
		return
	end

	for _, tab in cx.session:tabs() do
		local l = cx.session:layout(tab.id)
		if l and l.root then
			local total = 0
			local sidebar_count = 0
			local sidebar_pane: number? = nil

			local function count_leaves(tree: any)
				if not tree then
					return
				end
				if tree.pane then
					total += 1
					if model.is_mine(cx, tree.pane) then
						sidebar_count += 1
						sidebar_pane = tree.pane
					end
				end
				count_leaves(tree[1])
				count_leaves(tree[2])
			end

			count_leaves(l.root)

			if total > 0 and total == sidebar_count and sidebar_pane then
				cx.layout:close(sidebar_pane)
				model.invalidate()
			end
		end
	end
end

export type TabFlags = {
	busy: boolean,
	waiting: boolean,
	--- An unseen warning that is not a finished turn: a command or a program that failed
	--- (`alert`, the `!` badge).
	alert: boolean,
	--- A finished turn nobody has looked at yet: Tern's unseen alert on an agent that is
	--- back to `idle`. Its own flag and its own badge (the cyan `✓`) because a turn that
	--- ended well is not a failure — the two used to be the same `!`.
	done: boolean,
	is_agent: boolean,
}

--- The agent state last observed, by pane. One map, the single source the tab badges
--- (`flags_from`, through the snapshot) and the chimes (`observe_agents`, through the read
--- tick's poll) both read, so what the rail draws and what it plays can never come from two
--- different ideas of what an agent is doing. Module-level: one rail, one observation. Only
--- `observe_agents` writes it, and a failed read never does (see there).
local observed: { [number]: string } = {}

--- The states a fresh `agents:list()` lists, by pane id. Pure: one loop over the list the
--- caller already read — never a second `agents:list`. Keyed by `pane` and not by `agent`,
--- which is what keeps several agents of one tab apart.
local function states_of(agents: { any }): { [number]: string }
	local out: { [number]: string } = {}
	for _, a in agents do
		if a.pane then
			out[a.pane] = a.state
		end
	end
	return out
end

--- One agent that moved between two polls: its pane, the state it was in (nil on a first
--- sighting) and the one it is in now, plus whether its pane sits in the tab you are on —
--- the fact the chime rule needs and the model knows.
export type AgentMove = { pane: number, prev: string?, next: string, active: boolean }

--- Folds one `agents:list()` answer — as `states_of` folded it under `model.poll_agents` —
--- into the observed state and reports the moves it made. Pure in, moves out: no second
--- `agents:list`, no file, no process. Called only by the poll, never by a paint.
---
--- `states == nil` is a read that failed: the state is left exactly as it was, so a
--- transition this poll cannot judge is judged by the next one — delayed, never missed.
--- An unusable pane list is the same case: nothing is replaced, because a move cannot be
--- attributed to a tab without it. A map — even an empty one, the rail with no agents at
--- all — replaces the state, so an agent that is gone is forgotten and a later agent in
--- its pane seeds fresh instead of inheriting the moves of a program it is not.
function model.observe_agents(
	states: { [number]: string }?,
	panes: { [number]: PaneInfo }?,
	focused_tab: number?
): { AgentMove }
	if states == nil or panes == nil or next(panes) == nil then
		return {}
	end
	local moves: { AgentMove } = {}
	for pane, state in states do
		local prev = observed[pane]
		if prev ~= state then
			local info = panes[pane]
			table.insert(moves, {
				pane = pane,
				prev = prev,
				next = state,
				active = info ~= nil and info.tab ~= nil and info.tab == focused_tab,
			})
		end
	end
	-- By pane, so the queue one poll leaves is the same whatever order the read came back
	-- in (a table walk is not ordered).
	table.sort(moves, function(a: AgentMove, b: AgentMove): boolean
		return a.pane < b.pane
	end)
	observed = states
	return moves
end

--- The state the poll observed for one pane, or nil when it has seen no agent there. The
--- pane-level view of the same cache the badges read per tab: a consumer that needs one pane
--- — the attention jump — looks it up here instead of reading `agents:list` again.
function model.observed_agent(pane: number): string?
	return observed[pane]
end

--- Per-tab status badges from panes + agent states (keyed by AgentBlock.pane, NOT
--- .agent). Pure: both reads arrive as arguments, so one snapshot builds the flags
--- once for the fingerprint and for the draw.
function model.flags_from(panes: { PaneInfo }, agents: { [number]: string }?): { [number]: TabFlags }
	local out: { [number]: TabFlags } = {}
	local agent_map: { [number]: string } = agents or {}

	for _, p in panes do
		if p.tab then
			local tf = out[p.tab]
			if not tf then
				tf = { busy = false, waiting = false, alert = false, done = false, is_agent = false }
				out[p.tab] = tf
			end
			local ag_state = agent_map[p.pane]
			if ag_state ~= nil then
				-- The pane HAS an agent, so its state is the truth about the work. `busy` and
				-- `running` are the agent's own program: an `omp` between turns keeps
				-- `running = {line = "omp", ms = …}` (measured: `state = "idle"` with
				-- `running` set on every idle agent block), and OR-ing that in handed an idle
				-- agent the `◐` badge forever. The two pane signals stay as the fallback for
				-- the panes that have no agent entry — a shell running a long command still
				-- paints `◐` (see research/agent-states.md §10.3).
				if ag_state == "working" then
					tf.busy = true
				end
			elseif p.busy or p.running ~= nil then
				tf.busy = true
			end
			if ag_state == "waiting_input" then
				tf.waiting = true
			end
			-- `pane.alert` is Tern's own "you have not seen this": it is raised when an agent
			-- stops in a pane you are not looking at, and cleared when the pane is focused.
			-- One flag, two very different things, told apart by what the agent is now: an
			-- agent back to `idle` finished its turn (`done`, the cyan `✓`), while a non-zero
			-- `last.status` — a command or a program that failed — is an error (`alert`, the
			-- red `!` as before). A pane the agent list has no entry for keeps the old
			-- reading at the pane level: an unseen alert with nothing to explain it is an
			-- alert, and so is an agent that is not idle (`exited`, or a question that the
			-- `waiting` branch paints first).
			local failed = p.last ~= nil and p.last.status ~= 0
			if p.alert and not failed and ag_state == "idle" then
				tf.done = true
			elseif p.alert or failed then
				tf.alert = true
			end
			if p.kind == "agent" then
				tf.is_agent = true
			end
		end
	end
	return out
end

--- The same flags, reading the panes from the window. Only for callers that hold no
--- snapshot. The agent states are the poll's cache (`observed`), never a read of its own.
function model.collect_tab_flags(cx: WindowCx): { [number]: TabFlags }
	local ok_p, panes = pcall(function()
		return cx.session:panes()
	end)
	return model.flags_from(if ok_p and panes then panes else {}, observed)
end

--- Pane info by pane id, for the tab labels: one read instead of one per tab.
local function panes_by_id(panes: { PaneInfo }): { [number]: PaneInfo }
	local out: { [number]: PaneInfo } = {}
	for _, p in panes do
		out[p.pane] = p
	end
	return out
end

--- Tabs grouped by session, in the order `cx.session:tabs()` returned them: one pass
--- instead of one scan of every tab per drawn row.
local function tabs_by_session(tabs: { TabInfo }, sessions: { ManagedSession }): { [number]: { TabInfo } }
	local out: { [number]: { TabInfo } } = {}
	for _, s in sessions do
		out[s.id] = {}
	end
	for _, t in tabs do
		local list = out[t.session]
		if list then
			table.insert(list, t)
		end
	end
	return out
end

-- The cwd that identifies a session: its first tab with a working directory.
function model.session_cwd(cx: WindowCx, session_id: number): string?
	return model.cwd_of(cx.session:tabs(), session_id)
end

--- The same, over a tab list the caller already read.
function model.cwd_of(tabs: { TabInfo }, session_id: number): string?
	for _, t in tabs do
		if t.session == session_id and t.cwd and t.cwd ~= "" then
			return t.cwd
		end
	end
	return nil
end

-- Worktree the session sits in, from the cache only: no process is started, so a draw
-- may call it. nil while nothing is known yet — the poll fills it in over the next
-- ticks — and stale values are kept, because a branch name a second old beats a hole.
function model.worktree(cx: WindowCx, session_id: number): worktrees.Info?
	return model.worktree_peek(cx.session:tabs(), session_id)
end

--- The same over a tab list the caller already read.
function model.worktree_peek(tabs: { TabInfo }, session_id: number): worktrees.Info?
	local cwd = model.cwd_of(tabs, session_id)
	if not cwd then
		return nil
	end
	return worktrees.info_peek(cwd)
end

--- The same, starting the read when the cache is cold or stale. For user actions —
--- menus and the worktree flows — where "not a git checkout" must never be guessed.
--- Never call it from a draw: one cold `git rev-parse` can cost a whole call budget.
function model.worktree_live(cx: WindowCx, session_id: number): worktrees.Info?
	local cwd = model.session_cwd(cx, session_id)
	if not cwd then
		return nil
	end
	return worktrees.info_for(cwd)
end

--- The one place the plugin reads the agents: the read tick's poll. Reads the window's
--- agent list, its panes and its focused tab, folds the list into per-pane states and hands
--- them to `observe_agents`, which folds them into the single observed state and returns the
--- moves. It never draws: the paint reads that same observed state (see `snapshot`), which
--- is why a question cannot be shown before it has been heard. Returns the moves, for the
--- read tick to hand to `sound.observe` in the same invocation.
function model.poll_agents(cx: WindowCx): { AgentMove }
	local ok_ag, agents = pcall(function()
		return cx.agents:list()
	end)
	local ok_p, panes = pcall(function()
		return cx.session:panes()
	end)
	local states: { [number]: string }? = if ok_ag and agents then states_of(agents) else nil
	local focused_pane = cx.session:focused()
	local focused_tab = if focused_pane then cx.session:tab_of(focused_pane) else nil
	return model.observe_agents(states, panes_by_id(if ok_p and panes then panes else {}), focused_tab)
end

-- The rail's rows: the session list in order, with each repo's worktrees nested under
-- the session that holds its main checkout. Pure map work over the cached read, so a
-- draw can call it; the nesting rules live in group.luau.
function model.rail_rows(cx: WindowCx): { group.Row }
	local items: { group.Item } = {}
	for _, s in cx.sessions:list() do
		local wt = model.worktree(cx, s.id)
		table.insert(items, {
			id = s.id,
			repo_key = if wt then wt.repo_key else nil,
			linked = if wt then wt.linked else false,
		})
	end
	return group.arrange(items)
end

-- Fold state of every row, in one pass: the explicit kv each session carries, layered
-- over group.folded for the rows that have none. The view, the fingerprint and the menu
-- all read this, so they agree on what is hidden.
function model.collapsed_map(cx: WindowCx): { [number]: boolean }
	return model.fold_rows(model.rail_rows(cx), cx.sessions:current().id)
end

--- The fold map for rows the caller already built.
function model.fold_rows(rows: { group.Row }, current: number?): { [number]: boolean }
	local explicit: { [number]: boolean? } = {}
	for _, r in rows do
		local saved = tern.kv.get("fold_" .. r.id)
		if saved ~= nil then
			explicit[r.id] = saved == true
		end
	end
	return group.folded(rows, explicit, current)
end

--- Everything one repaint needs, read once. A draw is on the window's UI thread with a
--- 50 ms budget, so the number of `cx` calls per repaint is the thing to keep small:
--- this does one `sessions:list`, one `session:tabs`, one `session:panes`, one
--- `session:focused` and cache lookups, and the fingerprint and the tree then work off
--- these tables instead of re-reading the window between them.
---
--- Nothing here starts a process or a git read: `wt` and `head` come from the caches,
--- and nil means "not known yet" (the poll fills those in). Nor does it read the agents:
--- the flags come from the state the read tick's poll cached (`model.poll_agents`), so a
--- paint can never consume a move and hears nothing on its own.
export type Snapshot = {
	sessions: { ManagedSession },
	--- The current session's id.
	current: number,
	tabs: { TabInfo },
	--- Tabs of each session, in order.
	tabs_of: { [number]: { TabInfo } },
	--- Pane info by pane id, for tab labels.
	panes: { [number]: PaneInfo },
	flags: { [number]: TabFlags },
	rows: { group.Row },
	folded: { [number]: boolean },
	--- Worktree info per session id; nil while unknown.
	wt: { [number]: worktrees.Info? },
	--- Ahead/behind per session id; nil while unknown or not in git.
	head: { [number]: worktrees.Head? },
	--- Tab the focused pane belongs to.
	focused_tab: number?,
}

function model.snapshot(cx: WindowCx): Snapshot
	local sessions = cx.sessions:list()
	local tabs = cx.session:tabs()
	local ok_p, panes = pcall(function()
		return cx.session:panes()
	end)
	local pane_list: { PaneInfo } = if ok_p and panes then panes else {}

	local current = 0
	for _, s in sessions do
		if s.current then
			current = s.id
		end
	end

	local focused_pane = cx.session:focused()
	local focused_tab = if focused_pane then cx.session:tab_of(focused_pane) else nil

	local wt: { [number]: worktrees.Info? } = {}
	local head: { [number]: worktrees.Head? } = {}
	local items: { group.Item } = {}
	for _, s in sessions do
		local info = model.worktree_peek(tabs, s.id)
		wt[s.id] = info
		head[s.id] = if info then worktrees.head_peek(info.root) else nil
		table.insert(items, {
			id = s.id,
			repo_key = if info then info.repo_key else nil,
			linked = if info then info.linked else false,
		})
	end

	local rows = group.arrange(items)
	return {
		sessions = sessions,
		current = current,
		tabs = tabs,
		tabs_of = tabs_by_session(tabs, sessions),
		panes = panes_by_id(pane_list),
		flags = model.flags_from(pane_list, observed),
		rows = rows,
		folded = model.fold_rows(rows, current),
		wt = wt,
		head = head,
		focused_tab = focused_tab,
	}
end

--- What the poll reads next: one stale checkout at a time, then one stale ahead/behind
--- per repo. Peek-only — the caller starts the read — and nil when everything is fresh.
---
--- One per tick is what keeps every window call inside its budget: a cold
--- `git rev-parse` alone can cost a good part of the 50 ms, and asking for seven of
--- them in one call is what used to trip the hook and freeze the whole rail.
export type Read = { cwd: string } | { root: string }

function model.next_read(cx: WindowCx): Read?
	local sessions = cx.sessions:list()
	local tabs = cx.session:tabs()
	for _, s in sessions do
		local cwd = model.cwd_of(tabs, s.id)
		if cwd and worktrees.info_stale(cwd) then
			return { cwd = cwd }
		end
	end
	for _, s in sessions do
		local cwd = model.cwd_of(tabs, s.id)
		local info = if cwd then worktrees.info_peek(cwd) else nil
		if info and worktrees.head_stale(info.root) then
			return { root = info.root }
		end
	end
	return nil
end

--- How many rows are drawn under `sid`; 0 when the session is not a parent.
function model.children_of(cx: WindowCx, sid: number): number
	for _, r in model.rail_rows(cx) do
		if r.id == sid then
			return r.children
		end
	end
	return 0
end

--- Ahead/behind for a session's checkout, from the cache only; nil while the session
--- is not in a git checkout or git has not answered yet.
function model.head(cx: WindowCx, session_id: number): worktrees.Head?
	local wt = model.worktree(cx, session_id)
	if not wt then
		return nil
	end
	return worktrees.head_peek(wt.root)
end

--- What `Close group` on `sid` acts on: its nested sessions first, then the session
--- itself; locked sessions come back in `kept` for the caller to leave alone.
function model.group_close_ids(cx: WindowCx, sid: number): { close: { number }, kept: { number } }
	local locked: { [number]: boolean } = {}
	for _, s in cx.sessions:list() do
		if s.locked then
			locked[s.id] = true
		end
	end
	return group.close_set(model.rail_rows(cx), sid, locked)
end

-- Sessions sitting inside a checkout. Every one of them must end before git removes
-- the folder: Windows cannot delete a directory a running program still uses, which is
-- why herdr stops a workspace's terminals before removing a checkout.
local function sessions_in(cx: WindowCx, root: string): { ManagedSession }
	local out: { ManagedSession } = {}
	for _, s in cx.sessions:list() do
		local cwd = model.session_cwd(cx, s.id)
		if cwd and git.is_inside(cwd, root) then
			table.insert(out, s)
		end
	end
	return out
end

--- Ids of the sessions whose cwd is inside `root`.
function model.sessions_at(cx: WindowCx, root: string): { number }
	local out: { number } = {}
	for _, s in sessions_in(cx, root) do
		table.insert(out, s.id)
	end
	return out
end

--- A session that was ended, kept so it can be put back when git then refuses.
export type ClosedSession = { name: string, cwd: string }

--- Ends every session sitting in `root` and says which. Returns what it closed so the
--- caller can restore them if the removal fails.
function model.close_sessions_at(cx: WindowCx, root: string): { ClosedSession }
	local closed: { ClosedSession } = {}
	for _, s in sessions_in(cx, root) do
		table.insert(closed, { name = s.name, cwd = model.session_cwd(cx, s.id) or root })
		cx.sessions:close(s.id)
	end
	return closed
end

export type DeleteCheckoutOpts = {
	--- The linked checkout to remove.
	root: string,
	--- The repo's main checkout, where git runs.
	main_checkout: string,
}

--- The sidebar's delete flow for a linked checkout, without UI: it ends every session
--- sitting in the checkout, reads how many paths changed, and removes it. The
--- irreversible step is the caller's to confirm: `confirm` is asked when the checkout
--- has changes, and also when git itself refuses the unforced attempt for the one case
--- `--force` overrides — submodules, or a checkout that got dirty after the count was
--- read. Answering yes retries once with force.
---
--- `confirm(detail, cx, cb)` shows `detail` and answers `cb(force, cx)`, passing the
--- fresh context of its own hook. `cb(err, cx, removed, closed)` ends the flow: `err`
--- is git's message, `removed` says whether the folder went, and `closed` lists the
--- sessions that ended, so the caller can put them back.
function model.delete_checkout(
	cx: WindowCx,
	o: DeleteCheckoutOpts,
	confirm: (detail: string, cx: WindowCx, cb: (force: boolean, cx: WindowCx?) -> ()) -> (),
	cb: (err: string?, cx: WindowCx?, removed: boolean, closed: { ClosedSession }) -> ()
)
	local closed: { ClosedSession } = {}

	local function attempt(force: boolean, cxNow: WindowCx)
		if #closed == 0 then
			for _, s in model.close_sessions_at(cxNow, o.root) do
				table.insert(closed, s)
			end
		end
		worktrees.remove(o.main_checkout, o.root, force, function(err, cxRemoved)
			local fresh = cxRemoved or cxNow
			if err and not force and git.needs_force(err) then
				confirm(err .. " — " .. o.root, fresh, function(go, cxConfirm)
					if not go then
						cb(err, cxConfirm or fresh, false, closed)
						return
					end
					attempt(true, cxConfirm or fresh)
				end)
				return
			end
			cb(err, fresh, err == nil, closed)
		end)
	end

	worktrees.dirty(o.root, function(count, cxDirty)
		local fresh = cxDirty or cx
		if count <= 0 then
			attempt(false, fresh)
			return
		end
		confirm(tostring(count) .. " changed paths — " .. o.root, fresh, function(go, cxConfirm)
			if not go then
				cb(nil, cxConfirm or fresh, false, closed)
				return
			end
			attempt(true, cxConfirm or fresh)
		end)
	end)
end

export type SessionMenuOpts = {
	sid: number,
	--- Whether the session's rows are folded.
	collapsed: boolean,
	locked: boolean,
	--- How many sessions the window has; closing is offered only above one.
	count: number,
	--- How many worktree sessions are nested under this one; 0 makes it a plain close.
	children: number,
	--- What the session's cwd is, when it is a git checkout.
	worktree: { linked: boolean, repo_name: string, root: string }?,
}

--- The session menu, in order. Pure so the wording and the gating can be tested
--- without a window. The worktree entries are herdr's, verbatim: new and open come
--- from the repo's main checkout, delete from a linked one.
function model.session_menu_items(o: SessionMenuOpts): { PickItem }
	local items: { PickItem } = {
		{ label = "Open workspace", icon = "sidebar", act = "ws:" .. o.sid },
		{ label = "Rename workspace", icon = "pen", act = "ren:" .. o.sid },
		{ label = "New tab", icon = "plus", act = "new_tab:" .. o.sid },
	}

	local wt = o.worktree
	if wt and wt.linked then
		table.insert(items, {
			label = "Delete worktree checkout...",
			detail = wt.root,
			icon = "x",
			act = "wt_del:" .. o.sid,
		})
	elseif wt then
		table.insert(items, {
			label = "New worktree",
			detail = wt.repo_name,
			icon = "branch",
			act = "wt_new:" .. o.sid,
		})
		table.insert(items, {
			label = "Open worktree...",
			detail = wt.repo_name,
			icon = "branch",
			act = "wt_open:" .. o.sid,
		})
	end

	table.insert(items, {
		label = if o.collapsed then "Expand" else "Collapse",
		icon = if o.collapsed then "chev" else "chev-r",
		act = "fold:" .. o.sid,
	})
	table.insert(items, { label = if o.locked then "Unlock" else "Lock", icon = "lock", act = "toggle_lock:" .. o.sid })
	table.insert(items, { label = "New workspace", icon = "sidebar", act = "new" })
	if o.count > 1 then
		if o.children > 0 then
			table.insert(items, { label = "Close group", icon = "x", act = "close_group:" .. o.sid })
		else
			table.insert(items, { label = "Close workspace", icon = "x", act = "close:" .. o.sid })
		end
	end
	return items
end

-- Re-applies persisted tab colors (kv "tab_color_<id>"); no-op when tags disabled
function model.restore_tab_colors(cx: WindowCx)
	if tern.kv.get("color_tags_enabled") == false then
		return
	end
	for _, t in cx.session:tabs() do
		local saved = tern.kv.get("tab_color_" .. t.id)
		if saved ~= nil and t.color ~= saved then
			pcall(function()
				cx.layout:color_tab(t.id, saved)
			end)
		end
	end
end

return model

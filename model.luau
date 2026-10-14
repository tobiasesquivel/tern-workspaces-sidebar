--!strict
-- Sidebar pane ownership, memoized reads, health logic (dedup, auto-close, tab flags).

local TITLE = "Workspaces"

local worktrees = require("./worktrees")
local git = require("./git")
local group = require("./group")

--- The runtime bridge, compiled by `warmup` on the first read tick: a top-level
--- `require("./runtime")` would add its compile to the hook that loads this module.
local runtime: any = nil
local runtime_warmed = false
--- Production requires the bridge on the first read tick (`warmup`), never at the top
--- level; the suites swap in their own through `set_runtime`.
local runtime_loader: (() -> any)? = function()
	return require("./runtime")
end

local model = {}

--- Swaps the loader (a function) or hands the bridge in warm (the suites). True when
--- newly warm.
function model.set_runtime(mod: any): boolean
	local was = runtime_warmed
	if type(mod) == "function" then
		runtime_loader = mod
	else
		runtime = mod
		runtime_warmed = mod ~= nil
	end
	return not was and runtime_warmed
end

--- Loads the bridge outside the load hook. True when this tick warmed it (caller
--- returns before any I/O); false when warm or loaderless.
function model.warmup(): boolean
	if runtime_warmed then
		return false
	end
	local load = runtime_loader
	if load == nil then
		return false
	end
	local ok, mod = pcall(load)
	if not ok or mod == nil then
		return false
	end
	runtime = mod
	runtime_warmed = true
	return true
end

--- The chime handoff `sound.flush` asks first: true when the daemon took the chime (it
--- starts the player outside the window), false when there is no warm bridge or no live
--- daemon, and the sound module plays it itself.
function model.hand_chime(kind: string): boolean
	if runtime == nil then
		return false
	end
	return runtime.chime(kind) == true
end

--- The read tick's daemon `ensure`, through the bridge the model holds: true only when
--- it really spawned, so the tick spends its one spawn on it. False while the bridge
--- is not warm yet — the warmup tick does no I/O.
function model.ensure_runtime(): boolean
	if runtime == nil then
		return false
	end
	return runtime.ensure() == true
end

--- The tab holding `pane`. `cx.session:tab_of` answers nil for panes the window lists
--- (measured: a tab another client created, and one `ctl tab new` opened — `panes()` and
--- `tabs()` list them with their tab, while `tab_of`, `pane` and `layout` answer nil),
--- and a nil active tab made the rail focus the session's first tab: a tab switch
--- bounced straight back. The pane list is the fallback, one scan.
function model.tab_of(cx: WindowCx, pane: number): number?
	local tab = cx.session:tab_of(pane)
	if tab ~= nil then
		return tab
	end
	local ok, panes = pcall(function()
		return cx.session:panes()
	end)
	if ok and panes then
		for _, p in panes do
			if p.pane == pane then
				return p.tab
			end
		end
	end
	return nil
end

-- Per-cycle cache; window.luau invalidates at each cycle start / mutation
local cache_panes: { number } = {}
local cache_valid = false

function model.invalidate()
	cache_valid = false
end

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
		if model.tab_of(cx, pane) == tab_id then
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
		local tab = model.tab_of(cx, pane)
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
	--- (the `!` badge).
	alert: boolean,
	--- A finished turn nobody has looked at yet: the daemon's explicit `done`. Its own
	--- flag and its own badge (the cyan `✓`) because a turn that ended well is not a
	--- failure — the two used to be the same `!`.
	done: boolean,
	is_agent: boolean,
}

--- The final agent state per pane, as the daemon arbitrated it (`snapshot.json`), by
--- pane. One map, the single source the tab badges (`flags_from`, through the
--- snapshot) and the chimes (through the read tick's poll) both read, so what the rail
--- draws and what it plays can never come from two different ideas of what an agent
--- is doing. Module-level: one rail, one observation. Only `observe_final` writes
--- it, and a failed snapshot read never does (see there). A valid empty read — the
--- daemon answering with no agents — replaces it, so an agent that is gone is
--- forgotten; a failed one is retried on the next tick — delayed, never missed. A
--- snapshot gone quiet past `runtime.is_dead` clears this instead of painting a live
--- rail that is not (see `poll_agents`).
export type FinalState = { status: string, failed: boolean, done: boolean, id: string?, completion: number? }

--- The map the daemon's snapshot folds into, the contract `runtime.read_snapshot`
--- hands over. Keys stay the daemon's pane ids: pane ids past 2^32 survive as JSON
--- numbers end to end and are never truncated on the way here. `id` is the occupant
--- identity (`terminal_id`), `completion` the daemon's `completion_seq`: together they
--- tell a new occupant in an old pane apart from the one that left it.
local observed: { [number]: FinalState } = {}

--- The chime language of one pane's final state: `blocked` is the question mark, the
--- `done` status the background completion. `unknown` maps to itself and never to a
--- false `working`.
local function chime_of(fs: FinalState): string
	if fs.status == "blocked" then
		return "waiting_input"
	end
	if fs.status == "done" then
		return "idle"
	end
	return fs.status
end

--- One agent that moved between two polls: its pane, the state it was in (nil on a
--- first sighting) and the one it is in now, plus whether its pane sits in the tab
--- you are on — the fact the chime rule needs and the model knows. `done` carries
--- the daemon's explicit completion flag, so a completion the poll never saw as a
--- native transition still chimes.
export type AgentMove = { pane: number, prev: string?, next: string, active: boolean, done: boolean }

--- Folds one daemon snapshot — already read once by the poll — into the observed
--- state and reports the moves it made. Pure in, moves out: no snapshot read, no
--- second `agents:list`, no file, no process. Called only by the poll, never by a
--- paint. `panes` is the pane list by id, only to judge which tab each move sits in.
---
--- `final == nil` is a read that failed: the state is left exactly as it was, so a
--- transition this poll cannot judge is judged by the next one — delayed, never
--- missed. A map — even an empty one, the rail with no agents at all — replaces the
--- state, so an agent that is gone is forgotten and a later agent in its pane seeds
--- fresh instead of inheriting the moves of a program it is not.
function model.observe_final(
	final: { [number]: FinalState }?,
	panes: { [number]: PaneInfo }?,
	focused_tab: number?
): { AgentMove }
	if final == nil then
		return {}
	end
	-- Full diff in pane order, so the queue one poll leaves is the same whatever
	-- order the snapshot came back in (a table walk is not ordered). A pane the
	-- snapshot no longer names reads as an exit, which chimes nothing.
	local seen: { [number]: boolean } = {}
	for pane in final do
		seen[pane] = true
	end
	for pane in observed do
		seen[pane] = true
	end
	local ordered: { number } = {}
	for pane in seen do
		table.insert(ordered, pane)
	end
	table.sort(ordered)
	local moves: { AgentMove } = {}
	for _, pane in ordered do
		local fs = final[pane]
		local prev = observed[pane]
		-- A new occupant in an old pane is a first sighting, not a transition: the
		-- release may have cleared the snapshot between two polls, so the poll never
		-- saw the exit — without this, a new `working` agent inherits the old
		-- occupant's `done` edge and chimes false. Same pane, different `terminal_id`
		-- reads as unseen before. But the same occupant finishing two quick turns
		-- with no `working` snapshot in between must chime twice: a bigger valid
		-- `completion_seq` is a fresh completion even when `done` never cleared.
		local same_occupant = prev ~= nil
			and fs ~= nil
			and prev.id ~= nil
			and fs.id ~= nil
			and prev.id == fs.id
		local prev_state: string? = if prev == nil or not same_occupant then nil else chime_of(prev)
		local next_state: string? = if fs == nil then nil else chime_of(fs)
		local done_now = fs ~= nil and fs.done
		local completion_now: number? = if fs ~= nil then fs.completion else nil
		local completion_before: number? = if prev ~= nil and same_occupant then prev.completion else nil
		local completion_advanced = same_occupant
			and type(completion_now) == "number"
			and type(completion_before) == "number"
			and (completion_now :: number) > (completion_before :: number)
		local fresh_done = (done_now and not (prev ~= nil and prev.done and same_occupant))
			or (done_now and completion_advanced)
		if prev_state ~= next_state or fresh_done then
			local info = if panes ~= nil then panes[pane] else nil
			table.insert(moves, {
				pane = pane,
				prev = prev_state,
				next = if next_state == nil then "exited" else next_state,
				active = info ~= nil and info.tab ~= nil and info.tab == focused_tab,
				done = fresh_done,
			})
		end
	end
	observed = {}
	for pane, fs in final do
		observed[pane] = fs
	end
	return moves
end

--- Empties the observed state without reporting moves: the snapshot gone quiet past
--- `runtime.is_dead`, so the rail stops painting a cache the daemon no longer feeds.
--- The next live snapshot seeds fresh — first sightings, silent — instead of
--- inheriting the moves of agents it never saw.
function model.clear_observed()
	observed = {}
end

--- The state the poll observed for one pane, or nil when it has seen no agent
--- there, in the chime language (`blocked` reads as `waiting_input`). The
--- pane-level view of the same cache the badges read per tab: a consumer that needs
--- one pane — the attention jump — looks it up here instead of reading
--- `agents:list` again.
function model.observed_agent(pane: number): string?
	local fs = observed[pane]
	if fs == nil then
		return nil
	end
	return chime_of(fs)
end

--- Whether the daemon marked this pane's turn done and unseen: the `done` status,
--- without which no badge may claim a finished turn.
function model.observed_done(pane: number): boolean
	local fs = observed[pane]
	return fs ~= nil and fs.done
end

--- Whether the daemon kept this pane's failure flag while the agent lives.
function model.observed_failed(pane: number): boolean
	local fs = observed[pane]
	return fs ~= nil and fs.failed
end

--- Per-tab status badges from panes + final agent states (keyed by pane, NOT agent).
--- Pure: both reads arrive as arguments, so one snapshot builds the flags once for
--- the fingerprint and for the draw. `agents` is the poll's observed map; nil reads
--- as no agent anywhere, never as a failure.
---
--- The flag chain, in order: `working` → `◐`; `blocked` → `?`; the daemon's `done`
--- status (a finished turn nobody has looked at) → the cyan `✓` — outside
--- `pane.alert`, because the completion is the daemon's own state, not Tern's; the
--- daemon's `failed` (kept while the agent lives) or an unseen pane failure →
--- the red `!`; `unknown` paints nothing — never a false `working`.
function model.flags_from(panes: { PaneInfo }, agents: { [number]: FinalState }?): { [number]: TabFlags }
	local out: { [number]: TabFlags } = {}
	local agent_map: { [number]: FinalState } = agents or {}

	for _, p in panes do
		if p.tab then
			local tf = out[p.tab]
			if not tf then
				tf = { busy = false, waiting = false, alert = false, done = false, is_agent = false }
				out[p.tab] = tf
			end
			local fs = agent_map[p.pane]
			if fs ~= nil then
				-- The pane HAS a final state, so that state is the truth about the
				-- work. `busy` and `running` are the agent's own program: an `omp`
				-- between turns keeps `running = {line = "omp", ms = …}` (measured:
				-- `state = "idle"` with `running` set on every idle agent block),
				-- and OR-ing that in handed an idle agent the `◐` badge forever. The
				-- two pane signals stay as the fallback for the panes that have no
				-- final entry — a shell running a long command still paints `◐` (see
				-- research/agent-states.md §10.3).
				if fs.status == "working" then
					tf.busy = true
				end
			elseif p.busy or p.running ~= nil then
				tf.busy = true
			end
			if fs ~= nil and fs.status == "blocked" then
				tf.waiting = true
			end
			-- A finished turn is the daemon's own state: the `done` status nobody has
			-- looked at yet is the cyan `✓`, never the red `!`. A failure is the
			-- daemon's `failed` (kept while the agent lives) for a pane it has an entry
			-- for — the pane's `last.status` there is the shell's command from before
			-- the agent started, nothing the agent did — and a non-zero `last.status`
			-- only for a pane it has none for. Tern's own unseen `pane.alert` keeps
			-- the old reading at the pane level: an unseen alert with no finished turn
			-- to explain it is an alert.
			local failed = if fs ~= nil then fs.failed else (p.last ~= nil and p.last.status ~= 0)
			local done_here = fs ~= nil and fs.done
			if done_here and not failed then
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
--- Never call it from a draw: a cold read walks the disk, and a draw does no I/O.
function model.worktree_live(cx: WindowCx, session_id: number): worktrees.Info?
	local cwd = model.session_cwd(cx, session_id)
	if not cwd then
		return nil
	end
	return worktrees.info_for(cwd)
end

--- The one place the plugin reads the agents: the read tick's poll. Reads the
--- window's agent list once — the publication input, never drawn — publishes it for
--- the daemon (`runtime.publish`), then folds the daemon's single snapshot read into
--- the observed state and returns the moves. It never draws: the paint reads that
--- same observed state (see `snapshot`), which is why a question cannot be shown
--- before it has been heard. Returns the moves, for the read tick to hand to
--- `sound.observe` in the same invocation. The focused tab the tick is on is both
--- published and used to judge the moves (`active`), even with the rail unmounted:
--- focus is the window's, not the rail's. All file I/O is bounded in pcall: a read
--- that fails keeps the cache — except a snapshot gone quiet past `runtime.is_dead`,
--- which clears it instead of painting a live rail that is not.
function model.poll_agents(cx: WindowCx): { AgentMove }
	-- Warmup tick: compile the bridge and nothing else. The load hook cannot afford
	-- compile+I/O in one 50 ms budget, so this tick pays the compile and returns
	-- before any agents/list, fs, git or audio. No bridge at all (a view-only world
	-- whose harness never injected one) folds nothing either — same return, no I/O.
	if model.warmup() or runtime == nil then
		return {}
	end
	local ok_ag, agents = pcall(function()
		return cx.agents:list()
	end)
	local ok_tabs, tabs = pcall(function()
		return cx.session:tabs()
	end)
	local ok_p, panes = pcall(function()
		return cx.session:panes()
	end)
	local pane_list: { PaneInfo } = if ok_p and panes then panes else {}
	local tab_list: { TabInfo }? = if ok_tabs and tabs then tabs else nil
	local focused_pane = cx.session:focused()
	local focused_tab = if focused_pane then model.tab_of(cx, focused_pane) else nil
	-- Tern's pane ids are per client: map the daemon's to this window's before the
	-- observation goes out in the daemon's ids and the snapshot comes in as ours.
	pcall(runtime.sync_ids, cx)
	pcall(runtime.publish, if ok_ag and agents then agents else nil, pane_list, tab_list, focused_pane, focused_tab)
	local ok_snap, snap = pcall(runtime.read_snapshot, cx)
	local final: { [number]: FinalState }? = if ok_snap and snap then snap.states else nil
	if final == nil and runtime.is_dead() then
		model.clear_observed()
		return {}
	end
	return model.observe_final(final, panes_by_id(pane_list), focused_tab)
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
	local focused_tab = if focused_pane then model.tab_of(cx, focused_pane) else nil

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
--- One per tick is what keeps every window call inside its budget: asking for seven
--- reads in one call is what used to trip the hook and freeze the whole rail.
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

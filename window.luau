--!strict
-- Pinned Workspaces Sidebar for Tern — wiring only.
-- Logic lives in format.luau / model.luau / layout.luau / view.luau.
-- In Tern, canvas panes belong to a tab split tree; this plugin mounts the sidebar
-- canvas on the left of the active tab, syncs widths across tabs, and lists
-- sessions (= workspaces) with their tabs, badges and controls.

-- The load hook has the same 50 ms as any other, and compiling every module in it went
-- past (measured: ~35 ms of requires on top of this file's own ~12 ms). So the load
-- compiles this file only: each module is a proxy that requires it on its first use,
-- in whichever hook first touches it — the first read tick compiles `model` and does
-- nothing else, the first paint tick compiles the rail's modules (see the two ticks).
-- The annotations keep the real types; `typeof(require(...))` is erased at compile time.
local function lazy(load: () -> any): any
	local mod: any = nil
	return setmetatable({}, {
		__index = function(proxy: any, key: string): any
			if mod == nil then
				mod = load()
			end
			local value = mod[key]
			-- Module tables hold functions: cache each one on the proxy, so only the
			-- first access of a name goes through here.
			if type(value) == "function" then
				rawset(proxy, key, value)
			end
			return value
		end,
	})
end

local format: typeof(require("./format")) = lazy(function()
	return require("./format")
end)
local model: typeof(require("./model")) = lazy(function()
	return require("./model")
end)
local layout_mod: typeof(require("./layout")) = lazy(function()
	return require("./layout")
end)
local view_mod: typeof(require("./view")) = lazy(function()
	return require("./view")
end)
local git: typeof(require("./git")) = lazy(function()
	return require("./git")
end)
local worktrees: typeof(require("./worktrees")) = lazy(function()
	return require("./worktrees")
end)
local sound: typeof(require("./sound")) = lazy(function()
	return require("./sound")
end)

local TITLE = "Workspaces"
local HOME = tern.getenv("HOME") or ""
local opening = false
--- The fingerprint each rail was last drawn with, by pane.
local painted: { [number]: string } = {}
local tab_opening_times: { [number]: number } = {}

local function mine(cx: WindowCx): { number }
	return model.mine(cx)
end

-- One repaint. Reads the window once into a snapshot, compares its fingerprint and
-- only then pays for the tree, so a no-op event costs a snapshot and nothing else.
--
-- Nothing in here starts a git read or a process, and nothing in here reads the agents
-- either: `model.snapshot` draws its badges from the state the read tick's poll cached.
-- That is what keeps a paint from consuming a move the chime still owes you, and what
-- lets the rail be unmounted without muting anything. A repaint therefore fits the 50 ms
-- window budget no matter how many sessions the rail lists.
--
-- Every tab has its own rail, and each is drawn as seen from its own tab (`model.seen_from`):
-- its tab focused, its session current. The rail of the tab you switch to is on screen
-- before any hook runs, so it has to be right already; a switch then repaints nothing.
-- Each rail keeps its own fingerprint (`painted`). The rail on screen goes first; the
-- others follow while the call stays under PAINT_SLICE_MS, and the rest wait for the
-- next paint tick (they are not on screen).
local PAINT_SLICE_MS = 20
--- When the running hook started: the slice and the mount ahead are measured from it, so
--- one hook's mount, sync and repaint share its 50 ms instead of each taking a slice.
local hook_started = 0

--- The title each tab shows by its terminal, by tab id, for the moment the rail holds the
--- focus (see the `tab_title` formatter below).
local tab_labels: { [number]: string } = {}
--- The rail panes, by pane: a tab whose focused block is one of these is pressed on.
local rail_panes: { [number]: boolean } = {}

local SHELLS: { [string]: boolean } = {
	pwsh = true, powershell = true, cmd = true, bash = true, zsh = true, fish = true, sh = true, nu = true,
}

--- The last path segment, either slash.
local function base_name(path: string): string
	local trimmed = string.gsub(path, "[/\\]+$", "")
	return string.match(trimmed, "([^/\\]+)$") or trimmed
end

--- How Tern titles a tab by its terminal: the name the user gave it, else the folder of a
--- shell, else the program (measured: `w1` for a shell in `...\w1`, `cmd` for cmd.exe).
local function label_of(t: TabInfo): string?
	if t.name ~= nil and t.name ~= "" then
		return t.name
	end
	local program = string.lower(base_name(t.program or ""))
	program = string.gsub(program, "%.exe$", "")
	if (program == "" or SHELLS[program]) and t.cwd ~= nil and t.cwd ~= "" then
		return base_name(t.cwd)
	end
	if program ~= "" then
		return program
	end
	return nil
end

--- Keep each tab's terminal title and the rail panes for the formatter. `snap.tabs` already
--- describes a tab whose focused block is the rail by its terminal (`model.tabs_by_terminal`).
local function remember_labels(snap: any, panes: { number })
	local changed = false
	for _, t in snap.tabs do
		local label = label_of(t)
		if label ~= nil and tab_labels[t.id] ~= label then
			-- A first label needs no redraw: Tern asks the formatter when a press changes
			-- the tab's focused block. A label that changed (a `cd`) drops a cached answer.
			changed = changed or tab_labels[t.id] ~= nil
			tab_labels[t.id] = label
		end
	end
	local rails: { [number]: boolean } = {}
	for _, p in panes do
		rails[p] = true
	end
	rail_panes = rails
	if changed then
		pcall(tern.chrome.refresh)
	end
end

local function refresh(cx: WindowCx)
	local panes = mine(cx)
	if #panes == 0 then
		return
	end
	local ok_s, snap = pcall(model.snapshot, cx)
	if not ok_s or not snap then
		pcall(tern.log.warn, "ws snapshot failed: " .. tostring(snap))
		return
	end
	-- The group the current session hangs under opens for every rail, not only for the
	-- rails drawn from that session: all rails then hold the same rows at the same heights.
	pcall(model.reveal_current, snap.rows, snap.current)
	remember_labels(snap, panes)
	local order: { { pane: number, tab: number? } } = {}
	for _, pane in panes do
		local tab = model.tab_of(cx, pane)
		if tab ~= nil and tab == snap.focused_tab then
			table.insert(order, 1, { pane = pane, tab = tab })
		else
			table.insert(order, { pane = pane, tab = tab })
		end
	end
	local live: { [number]: boolean } = {}
	for i, item in order do
		live[item.pane] = true
		if i > 1 and tern.now() - hook_started > PAINT_SLICE_MS then
			continue
		end
		local seen = model.seen_from(snap, item.tab)
		local fp = view_mod.fingerprint(seen)
		if painted[item.pane] ~= fp then
			local ok, v = pcall(view_mod.build, seen)
			if not ok or not v then
				pcall(tern.log.warn, "ws view.build failed: " .. tostring(v))
				return
			end
			cx.canvas:set(item.pane, { view = v })
			painted[item.pane] = fp
		end
	end
	for pane in painted do
		if not live[pane] then
			painted[pane] = nil
		end
	end
end

--- Mount a rail in `tab_id`, already drawn as seen from that tab, on the left of the tab's
--- terminal and at the shared width. The tab may be one the window is not showing: the
--- paint tick mounts rails ahead (`premount`), so a visit never finds a tab without one.
local function open(cx: WindowCx, tab_id: number, focus: boolean)
	if opening then
		return
	end
	local now = tern.now()
	local last_time = tab_opening_times[tab_id]
	if last_time and (now - last_time) < 1200 then
		return
	end
	tab_opening_times[tab_id] = now

	opening = true
	pcall(function()
		local focused = cx.session:focused()
		local active_tab = if focused then model.tab_of(cx, focused) else nil
		local target = layout_mod.find_tab_terminal(cx, model.is_mine, tab_id)
		if not target and active_tab == tab_id then
			target = focused
		end
		if not target then
			-- A tab with nothing but a rail would be closed as empty: mount none.
			return
		end
		local pane, _err = cx.canvas:open({
			title = TITLE,
			about = "Workspaces Sidebar. Click a workspace to fold it, a tab to focus it, ⋯ for the menu. Hide closes the sidebar; Ctrl+Alt+B brings it back.",
			view = view_mod.build(model.seen_from(model.snapshot(cx), tab_id)),
			how = "beside",
			focus = focus,
		})
		if pane then
			model.invalidate()
			-- Straight to the left of the tab's terminal, whichever tab that is.
			local moved = cx.layout:move(pane, target, "left", { focus = false })
			if not moved and active_tab ~= tab_id then
				cx.layout:move_to_tab(pane, tab_id, { focus = false })
			end
			model.invalidate()
			if model.tab_of(cx, pane) ~= tab_id then
				-- The window refused both moves: the new rail sits beside the focused pane of
				-- the tab on screen. Moving that tab's terminal next to it would carry a
				-- terminal into another tab; close the stray rail and let a later tick retry.
				cx.layout:close(pane)
				model.invalidate()
				return
			end
			if active_tab ~= tab_id then
				-- The pane moved into a tab becomes that tab's focused block, so the rail
				-- would be: the tab's title would read `Workspaces` and the visit would land
				-- the keyboard on the rail. Moving the terminal back beside the rail hands the
				-- tab's focus to it, with no focus call (which would show that tab, and clear
				-- the alert of a terminal nobody looked at).
				cx.layout:move(target, pane, "right", { focus = false })
			end
			layout_mod.match_ratio(cx, model.is_mine, pane, tab_id, layout_mod.target_ratio())
		end
	end)
	opening = false
end

--- Mount the rail of one tab that has none yet, off the click's path: the tabs of the
--- current session first, then the others. One per call (the paint tick calls it), and only
--- in tabs Tern can lay out and that hold a terminal. Measured without it: the first visit to
--- a tab showed the terminal full width, then the rail sliding in (~270 ms).
local function premount(cx: WindowCx)
	if opening or not tern.kv.get("pinned") then
		return
	end
	-- A mount costs a build, an open, a move and a few resizes: only in a hook that has
	-- most of its budget left. The next tick tries again.
	if tern.now() - hook_started > 10 then
		return
	end
	local has: { [number]: boolean } = {}
	for _, p in mine(cx) do
		local t = model.tab_of(cx, p)
		if t then
			has[t] = true
		end
	end
	local cur = cx.sessions:current().id
	local now = tern.now()
	local tabs = cx.session:tabs()
	for pass = 1, 2 do
		for _, t in tabs do
			if not has[t.id] and ((pass == 1) == (t.session == cur)) then
				local last = tab_opening_times[t.id]
				if (last == nil or now - last >= 1200)
					and cx.session:layout(t.id) ~= nil
					and layout_mod.find_tab_terminal(cx, model.is_mine, t.id) ~= nil
				then
					open(cx, t.id, false)
					return
				end
			end
		end
	end
end

-- Ensures active tab in shown workspace has the sidebar mounted and synced
local function ensure_pinned(cx: WindowCx)
	if not tern.kv.get("pinned") then
		return
	end
	model.deduplicate_sidebars(cx)
	model.auto_close_empty_tabs(cx)
	model.restore_tab_colors(cx)

	local cur_session = cx.sessions:current().id
	local tr = layout_mod.target_ratio()
	local focused = cx.session:focused()
	local active_tab = if focused then model.tab_of(cx, focused) else nil

	-- Fallback if focused is nil: pick first tab in current session and focus its terminal
	if not active_tab then
		for _, t in cx.session:tabs() do
			if t.session == cur_session then
				active_tab = t.id
				local term = layout_mod.find_tab_terminal(cx, model.is_mine, t.id)
				if term then
					cx.layout:focus(term)
				end
				break
			end
		end
	end

	-- A tab Tern's layout API does not know (it lists the tab, but `layout` answers nil)
	-- cannot hold the rail: the rail could not find the one it mounted and opened another
	-- every tick. Leave that tab alone; the rail comes back on the next tab it can hold.
	if active_tab and cx.session:layout(active_tab) == nil then
		return
	end

	if active_tab then
		local has, pane = model.tab_has_sidebar(cx, active_tab)
		if not has then
			open(cx, active_tab, false)
		elseif pane then
			local l = cx.session:layout(active_tab)
			if l and l.root and l.root.ratio then
				-- Reposition sidebar to left if not already there
				if l.root[1] and not model.is_mine(cx, l.root[1].pane or 0) then
					local target = layout_mod.find_tab_terminal(cx, model.is_mine, active_tab)
					if target then
						cx.layout:move(pane, target, "left", { focus = false })
						model.invalidate()
					end
				end
				local cur_r = l.root.ratio
				local prev_known = layout_mod.known_ratio(active_tab)
				if prev_known and math.abs(cur_r - prev_known) > 0.015 and cur_r >= 0.05 and cur_r <= 0.60 then
					tern.kv.set("sidebar_ratio", cur_r)
					tr = cur_r
				end
				layout_mod.set_known_ratio(active_tab, cur_r)

				if math.abs(cur_r - tr) > 0.015 then
					layout_mod.match_ratio(cx, model.is_mine, pane, active_tab, tr)
				end
			end
		end
	end
end

-- Context inheritance helpers
local function current_context(cx: WindowCx): (string, string)
	local focused = cx.session:focused()
	local pinfo = if focused then cx.session:pane(focused) else nil
	local cwd = if pinfo and pinfo.cwd and pinfo.cwd ~= "" then pinfo.cwd else HOME
	local name = format.smart(cwd)
	if name == "~" or name == "terminal" then
		name = "workspace"
	end

	local existing: { [string]: boolean } = {}
	for _, s in cx.sessions:list() do
		existing[string.lower(s.name)] = true
	end
	if existing[string.lower(name)] then
		local idx = 2
		while existing[string.lower(name .. " " .. idx)] do
			idx += 1
		end
		name = name .. " " .. idx
	end

	return cwd, name
end

local function get_session_cwd(cx: WindowCx, session_id: number): string
	return model.session_cwd(cx, session_id) or HOME
end

-- Worktrees -----------------------------------------------------------------
-- Menus and flows mirror herdr: create from the repo's main checkout, open any
-- checkout git already knows, delete a linked checkout without touching its branch.

local function unique_session_name(cx: WindowCx, base: string): string
	local name = base
	local existing: { [string]: boolean } = {}
	for _, s in cx.sessions:list() do
		existing[string.lower(s.name)] = true
	end
	if existing[string.lower(name)] then
		local idx = 2
		while existing[string.lower(name .. " " .. idx)] do
			idx += 1
		end
		name = name .. " " .. idx
	end
	return name
end

-- A session already sitting in that checkout, if any.
local function session_at_checkout(cx: WindowCx, path: string): number?
	return model.sessions_at(cx, path)[1]
end

local function after_change(cx: WindowCx)
	model.invalidate()
	painted = {}
	pcall(ensure_pinned, cx)
	pcall(refresh, cx)
end

local function new_worktree(cx: WindowCx, wt: worktrees.Info)
	local seed = math.floor(tern.now() * 1000)
	cx:prompt({
		value = git.generated_branch(seed),
		placeholder = "Branch name",
		icon = "branch",
		action = "create",
	}):next(function(text: string?, _err: any, cx2: WindowCx?)
		if not cx2 or not text then
			return
		end
		local branch = (string.gsub(string.gsub(text, "^%s+", ""), "%s+$", ""))
		if branch == "" then
			cx2:toast("error", "A branch name is required")
			return
		end
		worktrees.list(wt.main_checkout, function(list)
			local taken = if list then git.taken_paths(list) else {}
			local path = worktrees.free_path(git.checkout_path(wt.main_checkout, branch), taken)
			worktrees.create(wt.main_checkout, branch, path, "HEAD", function(err, cx3)
				if not cx3 then
					return
				end
				if err then
					cx3:toast("error", err, "git worktree add")
					return
				end
				cx3.sessions:create({ name = unique_session_name(cx3, branch), cwd = path })
				cx3:toast("info", "Worktree " .. branch, path)
				after_change(cx3)
			end)
		end)
	end)
end

local function open_worktree(cx: WindowCx, wt: worktrees.Info)
	-- list hands back the fresh context of the process hook: the one this click got
	-- does not survive until the list lands, so the picker must run on that one.
	worktrees.list(wt.main_checkout, function(list, cxList)
		local c = cxList or cx
		if not list then
			c:toast("error", "Could not read the worktrees of " .. wt.repo_name)
			return
		end
		local items: { PickItem } = {}
		for _, w in git.openable(list) do
			local label = w.branch or git.base_name(w.path)
			table.insert(items, {
				label = label,
				detail = w.path,
				icon = "branch",
				current = session_at_checkout(c, w.path) ~= nil,
				target = w.path,
			})
		end
		if #items == 0 then
			c:toast("info", "No worktrees to open", wt.repo_name)
			return
		end
		c:pick({ items = items, placeholder = "Open worktree", icon = "branch" }):next(function(item: PickItem?, _err: any, cx2: WindowCx?)
			if not item or not cx2 or not item.target then
				return
			end
			local existing = session_at_checkout(cx2, item.target)
			if existing then
				cx2.sessions:switch(existing)
				after_change(cx2)
				return
			end
			local name = if item.label and item.label ~= "" then item.label else git.base_name(item.target)
			cx2.sessions:create({ name = unique_session_name(cx2, name), cwd = item.target })
			cx2:toast("info", "Opened " .. name, item.target)
			after_change(cx2)
		end)
	end)
end

-- El paso irreversible: el segundo picker, con la ruta del checkout en el detalle.
local function confirm_force(detail: string, cx: WindowCx, cb: (force: boolean, cx: WindowCx?) -> ())
	cx:pick({
		items = {
			{ label = "Delete anyway", detail = detail, icon = "x", act = "yes" },
			{ label = "Cancel", icon = "chev-r", act = "no" },
		},
		placeholder = "The checkout is removed with --force: nothing git keeps in it survives.",
		icon = "warning",
	}):next(function(item: PickItem?, _err: any, cx2: WindowCx?)
		cb(item ~= nil and cx2 ~= nil and item.act == "yes", cx2)
	end)
end

local function delete_worktree(cx: WindowCx, wt: worktrees.Info)
	cx:pick({
		items = {
			{ label = "Remove checkout", detail = wt.root, icon = "x", act = "yes" },
			{ label = "Cancel", icon = "chev-r", act = "no" },
		},
		placeholder = "Delete worktree checkout? The folder is removed and its sessions close. The branch is not deleted.",
		icon = "branch",
	}):next(function(item: PickItem?, _err: any, cx2: WindowCx?)
		if not item or not cx2 or item.act ~= "yes" then
			return
		end
		model.delete_checkout(cx2, {
			root = wt.root,
			main_checkout = wt.main_checkout,
		}, confirm_force, function(err, cx3, removed, closed)
			if not cx3 then
				return
			end
			if err then
				-- Nothing was destroyed: put the sessions it ended back and say what
				-- git said.
				for _, s in closed do
					pcall(function()
						cx3.sessions:create({ name = s.name, cwd = s.cwd })
					end)
				end
				cx3:toast("error", err, "git worktree remove")
			elseif removed then
				cx3:toast("info", "Checkout removed", wt.root)
			end
			after_change(cx3)
		end)
	end)
end

local function step(cx: WindowCx, d: number)
	local list = cx.sessions:list()
	for i, s in list do
		if s.current then
			cx.sessions:switch(list[(i - 1 + d) % #list + 1].id)
			return
		end
	end
end

-- Attention jump across all sessions. The agent half of the test is the state the read
-- tick's poll cached (`model.observed_agent`), never a read of its own: a second reader here
-- would be a reader that can fall out of step with the badge and the chime, and it would
-- consume nothing the poll already said. A read that failed leaves that cache standing, so a
-- jump still finds the question the poll last saw.
local function find_attention_tab(cx: WindowCx): (number?, number?)
	for _, t in cx.session:tabs() do
		local l = cx.session:layout(t.id)
		if l and l.root then
			local function scan(tree: any): number?
				if not tree then return nil end
				if tree.pane then
					local pinfo = cx.session:pane(tree.pane)
					if pinfo and not model.is_mine(cx, tree.pane) then
						-- The same test as ever, in the same tab and tree order: a question
						-- the poll cached, an unseen completion the daemon flagged, or the
						-- pane's own alert flags.
						if model.observed_agent(tree.pane) == "waiting_input"
							or model.observed_done(tree.pane)
							or pinfo.alert
							or (pinfo.last and pinfo.last.status ~= 0)
						then
							return tree.pane
						end
					end
				end
				return scan(tree[1]) or scan(tree[2])
			end
			local target = scan(l.root)
			if target then
				return t.id, target
			end
		end
	end
	return nil, nil
end

--- Turn the rail off — close the canvas of every tab and clear `pinned`, so new tabs stop
--- getting one — or back on: pin it and mount it on the tab the window is on. One
--- implementation behind the command, the status segment and the rail's own Hide badge.
local function toggle_sidebar(cx: WindowCx)
	-- Every rail in the canvas list, also one `mine` leaves out because the window's
	-- `pane()` does not describe it: Hide has to take that one away too.
	local panes = model.all_rails(cx)
	if tern.kv.get("pinned") or #panes > 0 then
		tern.kv.set("pinned", nil)
		for _, p in panes do
			cx.layout:close(p)
		end
		model.invalidate()
	else
		tern.kv.set("pinned", true)
		opening = false
		painted = {}
		ensure_pinned(cx)
		refresh(cx)
	end
end

tern.command({
	id = "toggle",
	title = "Workspaces: toggle sidebar",
	icon = "sidebar",
	keys = { "ctrl+alt+b" },
	run = toggle_sidebar,
})
tern.command({ id = "new", title = "Workspaces: new", icon = "plus", run = function(cx)
	local cwd, name = current_context(cx)
	cx.sessions:create({ name = name, cwd = cwd })
	painted = {}
	pcall(ensure_pinned, cx)
	pcall(refresh, cx)
end })
tern.command({
	id = "rename",
	title = "Workspaces: rename workspace",
	icon = "pencil",
	run = function(cx)
		cx:command("rename_session")
	end,
})
tern.command({
	id = "toggle_path_style",
	title = "Workspaces: toggle path style (smart / fish)",
	icon = "text",
	run = function(cx)
		local cur = tern.kv.get("path_style") or "smart"
		local next_style = if cur == "smart" then "fish" else "smart"
		tern.kv.set("path_style", next_style)
		cx:toast("info", "Path style: " .. next_style)
		painted = {}
		refresh(cx)
	end,
})
tern.command({
	id = "cycle_tab_color",
	title = "Workspaces: cycle active tab color",
	icon = "palette",
	keys = { "cmd+alt+shift+c" },
	run = function(cx)
		local focused = cx.session:focused()
		local tab_id = if focused then model.tab_of(cx, focused) else nil
		if tab_id then
			local cur_color: TabColor? = nil
			for _, t in cx.session:tabs() do
				if t.id == tab_id then
					cur_color = t.color or tern.kv.get("tab_color_" .. t.id)
					break
				end
			end
			local next_c = view_mod.next_tab_color(cur_color)
			cx.layout:color_tab(tab_id, next_c)
			tern.kv.set("tab_color_" .. tab_id, next_c)
			cx:toast("info", "Tab color: " .. (next_c or "none"))
			painted = {}
			refresh(cx)
		end
	end,
})
tern.command({
	id = "toggle_color_tags",
	title = "Workspaces: toggle color tags",
	icon = "palette",
	run = function(cx)
		local cur = tern.kv.get("color_tags_enabled")
		local next_val = if cur == false then true else false
		tern.kv.set("color_tags_enabled", next_val)
		cx:toast("info", "Color tags: " .. (if next_val then "ON" else "OFF"))
		if not next_val then
			for _, t in cx.session:tabs() do
				pcall(function()
					cx.layout:color_tab(t.id, nil)
				end)
			end
		else
			for _, t in cx.session:tabs() do
				local saved = tern.kv.get("tab_color_" .. t.id)
				if saved then
					pcall(function()
						cx.layout:color_tab(t.id, saved)
					end)
				end
			end
		end
		painted = {}
		refresh(cx)
	end,
})
tern.command({
	id = "toggle_color_labels",
	title = "Workspaces: toggle color tag labels",
	icon = "text",
	run = function(cx)
		local cur = tern.kv.get("color_labels_enabled")
		local next_val = if cur == false then true else false
		tern.kv.set("color_labels_enabled", next_val)
		cx:toast("info", "Color tag labels: " .. (if next_val then "ON" else "OFF"))
		painted = {}
		refresh(cx)
	end,
})
tern.command({
	id = "toggle_auto_close_empty",
	title = "Workspaces: toggle auto-close empty tabs",
	icon = "x",
	run = function(cx)
		local cur = tern.kv.get("auto_close_empty_tabs")
		if cur == nil then
			cur = true
		end
		local next_val = not cur
		tern.kv.set("auto_close_empty_tabs", next_val)
		cx:toast("info", "Auto-close empty tabs: " .. (if next_val then "ON" else "OFF"))
		if next_val then
			model.auto_close_empty_tabs(cx)
		end
	end,
})
tern.command({
	id = "toggle_sounds",
	title = "Workspaces: toggle notification sounds",
	icon = "bell",
	run = function(cx)
		local cur = tern.kv.get("sound_enabled")
		if cur == nil then
			cur = true
		end
		local next_val = not cur
		tern.kv.set("sound_enabled", next_val)
		cx:toast("info", "Notification sounds: " .. (if next_val then "ON" else "OFF"))
	end,
})
tern.command({ id = "next", title = "Workspaces: next", keys = { "cmd+alt+shift+]" }, run = function(cx) step(cx, 1) end })
tern.command({ id = "prev", title = "Workspaces: previous", keys = { "cmd+alt+shift+[" }, run = function(cx) step(cx, -1) end })

-- Direct workspace jumps Cmd+Alt+1..9 (on Windows that is Win+Alt+1..9; the preset
-- already owns ctrl+alt+1..4 and ctrl+alt+shift+1..9, so the Win key is what's left)
for i = 1, 9 do
	tern.command({
		id = "goto_ws_" .. i,
		title = "Workspaces: go to " .. i,
		run = function(cx)
			local list = cx.sessions:list()
			if #list >= i then
				cx.sessions:switch(list[i].id)
				refresh(cx)
			end
		end,
	})
end

-- Bind the chords through tern.bind at load (runs once per plugin VM start)
for i = 1, 9 do
	tern.bind("cmd+alt+" .. i, "plugin.workspaces-sidebar.goto_ws_" .. i)
end

-- Esc cancels move mode (guarded: only acts when moving_tab is set)
tern.bind("esc", function(cx: WindowCx)
	if tern.kv.get("moving_tab") then
		tern.kv.set("moving_tab", nil)
		cx:toast("info", "Move cancelled")
		painted = {}
		refresh(cx)
	end
end)

-- Attention jump command
tern.command({
	id = "attention",
	title = "Workspaces: next needing attention",
	icon = "bell",
	keys = { "cmd+alt+shift+a" },
	run = function(cx)
		local tab_id, pane = find_attention_tab(cx)
		if tab_id and pane then
			local target_tab: TabInfo? = nil
			for _, t in cx.session:tabs() do
				if t.id == tab_id then
					target_tab = t
					break
				end
			end
			if target_tab then
				local cur_s = cx.sessions:current().id
				if target_tab.session ~= cur_s then
					cx.sessions:switch(target_tab.session)
				end
				cx.layout:focus(pane)
				cx:toast("info", "Jumped to tab needing attention")
			end
		else
			cx:toast("info", "All tasks clear")
		end
	end,
})

-- Native chrome status line segment (pure formatter, reads cached snapshot)
local chrome_snapshot: ManagedSession? = nil

tern.chrome.status(function(_pane: StatusPaneInfo): { StatusSegment }?
	if not chrome_snapshot then
		return nil
	end
	local seg: StatusSegment = {
		text = " ▸ " .. chrome_snapshot.name,
		icon = "sidebar",
		tone = "accent",
		command = "plugin.workspaces-sidebar.toggle",
	}
	return { seg }
end)

--- While a press keeps the rail focused, Tern titles the tab after its focused block: the
--- rail, `Workspaces` (measured: one frame per press, before the focus handler hands the
--- keyboard back). That tab is titled after its terminal instead, the way Tern titles it
--- otherwise; every other tab keeps Tern's own title (nil).
tern.chrome.tab_title(function(tab: TabInfo): string?
	if rail_panes[tab.pane] or tab.title == TITLE then
		return tab_labels[tab.id]
	end
	return nil
end)

-- El click derecho no existe en las vistas de un plugin: el menú de una fila es un
-- picker nativo de Tern, abierto por el botón "⋯" o con doble click en la fila.
local canvas_action: any = nil

local function run_menu(cx: WindowCx, items: { PickItem }, placeholder: string, icon: string)
	cx:pick({ items = items, placeholder = placeholder, icon = icon }):next(function(item: PickItem?, _err: any, cx2: WindowCx?)
		if item and item.act and cx2 and canvas_action then
			canvas_action({
				owner = tern.plugin.id,
				pane = 0,
				act = item.act,
				-- A picked item is a decision, never a stray click (see STRAY_MS).
				node = "menu",
				text = item.label,
				title = TITLE,
				about = nil,
				value = nil,
				mods = nil,
			}, cx2)
		end
	end)
end

local function menu_for_session(cx: WindowCx, sid: number)
	local cur: ManagedSession? = nil
	local count = 0
	for _, s in cx.sessions:list() do
		count += 1
		if s.id == sid then
			cur = s
		end
	end
	if not cur then
		return
	end
	local collapsed = model.collapsed_map(cx)[sid] == true
	local wt = model.worktree_live(cx, sid)
	local items = model.session_menu_items({
		sid = sid,
		collapsed = collapsed,
		children = model.children_of(cx, sid),
		locked = cur.locked,
		count = count,
		worktree = if wt then { linked = wt.linked, repo_name = wt.repo_name, root = wt.root } else nil,
	})
	run_menu(cx, items, "Workspace actions", "sidebar")
end

local function menu_for_tab(cx: WindowCx, tid: number)
	local found = false
	for _, t in cx.session:tabs() do
		if t.id == tid then
			found = true
		end
	end
	if not found then
		return
	end
	local items: { PickItem } = {
		{ label = "Focus tab", icon = "play", act = "tab:" .. tid },
		{ label = "Rename tab", icon = "pen", act = "ren_tab:" .. tid },
		{ label = "Cycle color tag", icon = "palette", act = "color_tab:" .. tid },
		{ label = "Move to workspace", icon = "send", act = "moveto:" .. tid },
	}
	if #cx.session:tabs() > 1 then
		table.insert(items, { label = "Close tab", icon = "x", act = "close_tab:" .. tid })
	end
	run_menu(cx, items, "Tab actions", "tabs-h")
end

--- Hand the keyboard back to the terminal of the canvas' own tab.
---
--- A press inside the rail lands on the canvas pane, and Tern focuses the pane it was
--- clicked in before it dispatches the click: the tab then wears the canvas' header
--- title (`Workspaces`) and the keyboard sits in a pane that never types. The rail only
--- answers clicks, so a canvas that took the focus gives it back to the terminal beside
--- it — the pane the user was typing in.
---
--- This runs from the focus event because that is the one place every click of the rail
--- passes through: a row with an action, the padding between rows and a press the user
--- holds without releasing all steal the focus, and only the first of them ever reaches
--- canvas_action.
local function refocus_terminal(ev: any, cx: WindowCx)
	local pane = ev and ev.pane
	if not pane or not model.is_mine(cx, pane) then
		return
	end
	-- A focus event of the rail that arrives after the keyboard already moved on (a click
	-- that switched tabs) hands nothing back: doing so would pull the window back to the
	-- tab the click came from.
	local now_focused = cx.session:focused()
	if now_focused ~= nil and now_focused ~= pane then
		return
	end
	local tab = ev.tab or model.tab_of(cx, pane)
	local term = if tab then layout_mod.find_tab_terminal(cx, model.is_mine, tab) else nil
	if term then
		cx.layout:focus(term)
	end
end

--- When the last click on a row that moves rows (a tab switch, a fold) landed.
local last_row_click = -1e9
--- How long after such a click a footer badge does not answer.
local STRAY_MS = 1000
--- How long the tab a click moves to is kept out of dedup and auto-close.
local PROTECT_MS = 1500

canvas_action = function(ev: CanvasAction, cx: WindowCx): boolean?
	if ev.owner ~= tern.plugin.id then
		return nil
	end
	hook_started = tern.now()
	-- The press focused the rail before this click arrived. Hand the rail's own tab back to
	-- its terminal now, before any switch: once the click moves to another tab, the rail's
	-- focus event never does it, and that tab keeps the rail focused (its title reads
	-- `Workspaces` and going back puts the keyboard on the rail).
	local origin = if ev.pane ~= nil and ev.pane ~= 0 then ev.pane else cx.session:focused()
	if origin ~= nil then
		pcall(refocus_terminal, { pane = origin }, cx)
	end
	local kind, id = string.match(ev.act, "^([%a_]+):?(%d*)$")
	local n = tonumber(id)

	-- Cancel move mode via badge click
	if kind == "cancel_move" then
		tern.kv.set("moving_tab", nil)
		painted = {}
		refresh(cx)
		return true
	end

	-- The footer badges sit right under the last row, so a row that moves puts them under a
	-- pointer that did not move. A click on one of them that comes right after a click
	-- that switched tabs or folded a row is the second click of the user's gesture landing
	-- on the destination rail, not a decision: measured in the lab, a second click on a tab
	-- row hit `Hide` there and every rail closed.
	if (kind == "hide" or kind == "new") and ev.node ~= "menu" and tern.now() - last_row_click < STRAY_MS then
		pcall(tern.log.warn, "ws ignored " .. kind .. ": " .. tostring(math.floor(tern.now() - last_row_click)) .. " ms after a row click")
		return true
	end

	-- The rail's own Hide badge: the same toggle as the command and the status segment.
	-- Named `hide` because `toggle` is Tern's own action name and never reaches us.
	if kind == "hide" then
		toggle_sidebar(cx)
		return true
	end

	-- Modifier-click reorder on tab rows (drag-free alternative)
	-- shift-click tab row = move up, alt-click = move down
	if kind == "tab" and n and ev.mods then
		local held: { [string]: boolean } = {}
		for _, m in ev.mods do
			held[m] = true
		end
		local my_pos: number? = nil
		for _, t in cx.session:tabs() do
			if t.id == n then
				my_pos = t.position
				break
			end
		end
		if my_pos then
			if held["shift"] and my_pos > 1 then
				cx.layout:order_tab(n, my_pos - 1)
				painted = {}
				refresh(cx)
				return true
			elseif held["alt"] then
				cx.layout:order_tab(n, my_pos + 1)
				painted = {}
				refresh(cx)
				return true
			end
		end
	end

	if kind == "menu_ws" and n then
		menu_for_session(cx, n)
		return true
	elseif kind == "menu_tab" and n then
		menu_for_tab(cx, n)
		return true
	elseif kind == "wt_new" and n then
		local wt = model.worktree_live(cx, n)
		if not wt then
			cx:toast("error", "This workspace is not a git checkout")
		elseif wt.linked then
			cx:toast("info", "New worktrees start from the repo's main checkout", wt.main_checkout)
		else
			new_worktree(cx, wt)
		end
		return true
	elseif kind == "wt_open" and n then
		local wt = model.worktree_live(cx, n)
		if not wt then
			cx:toast("error", "This workspace is not a git checkout")
		elseif wt.linked then
			cx:toast("info", "Opening a worktree starts from the repo's main checkout", wt.main_checkout)
		else
			open_worktree(cx, wt)
		end
		return true
	elseif kind == "wt_del" and n then
		local wt = model.worktree_live(cx, n)
		if wt and wt.linked then
			-- It ends every session sitting in the checkout, this one included.
			delete_worktree(cx, wt)
		else
			cx:toast("error", "This workspace is not a linked worktree checkout")
		end
		return true
	elseif kind == "ren_tab" and n then
		local cur_title = ""
		for _, t in cx.session:tabs() do
			if t.id == n then
				cur_title = t.name or t.title or ""
			end
		end
		cx:prompt({ value = cur_title, placeholder = "Tab name", icon = "pen" }):next(function(text: string?, _err: any, cx2: WindowCx?)
			if text and text ~= "" and cx2 then
				cx2.layout:name_tab(n, text)
				painted = {}
				pcall(refresh, cx2)
			end
		end)
		return true
	elseif kind == "moveto" and n then
		local targets: { PickItem } = {}
		for _, s in cx.sessions:list() do
			table.insert(targets, {
				label = s.name,
				detail = if s.current then "current" else nil,
				icon = "sidebar",
				target = s.id,
			})
		end
		cx:pick({ items = targets, placeholder = "Move tab to workspace", icon = "send" }):next(function(item: PickItem?, _err: any, cx2: WindowCx?)
			if item and item.target and cx2 then
				local dest = item.target
				if cx2.sessions:current().id ~= dest then
					cx2.sessions:switch(dest)
				end
				local l = cx2.session:layout(n)
				if l and l.root then
					local panes_to_move = {}
					local function collect(t: TabTree?)
						if not t then
							return
						end
						if t.pane and not model.is_mine(cx2, t.pane) then
							table.insert(panes_to_move, t.pane)
						end
						collect(t[1])
						collect(t[2])
					end
					collect(l.root)
					for _, p in panes_to_move do
						cx2.layout:move_to_new_tab(p, dest, { focus = false })
					end
				end
				painted = {}
				pcall(refresh, cx2)
			end
		end)
		return true
	elseif kind == "ws" and n then
		for _, s in cx.sessions:list() do
			if s.id == n then
				cx.sessions:switch(n)
				break
			end
		end
	elseif kind == "fold" and n then
		-- The map already layers the stored key over the default, so the toggle negates it.
		tern.kv.set("fold_" .. n, not (model.collapsed_map(cx)[n] == true))
		last_row_click = tern.now()
	elseif kind == "toggle_lock" and n then
		-- Interactive lock toggle
		for _, s in cx.sessions:list() do
			if s.id == n then
				if s.locked then
					cx.sessions:unlock(n)
					cx:toast("info", s.name .. " unlocked")
				else
					cx.sessions:lock(n)
					cx:toast("info", s.name .. " locked")
				end
				break
			end
		end
	elseif kind == "color_tab" and n then
		-- Cycle and persist tab color tag
		local cur_c: TabColor? = nil
		for _, t in cx.session:tabs() do
			if t.id == n then
				cur_c = t.color or tern.kv.get("tab_color_" .. n)
				break
			end
		end
		local next_c = view_mod.next_tab_color(cur_c)
		cx.layout:color_tab(n, next_c)
		tern.kv.set("tab_color_" .. n, next_c)
	elseif kind == "tab_up" and n then
		for _, t in cx.session:tabs() do
			if t.id == n and t.position > 1 then
				cx.layout:order_tab(n, t.position - 1)
				break
			end
		end
	elseif kind == "tab_down" and n then
		for _, t in cx.session:tabs() do
			if t.id == n then
				cx.layout:order_tab(n, t.position + 1)
				break
			end
		end
	elseif kind == "move" and n then
		-- Enter move mode for this tab
		tern.kv.set("moving_tab", n)
		cx:toast("info", "Pick a workspace to move this tab to")
	elseif kind == "movehere" and n then
		-- Move pending tab panes into this workspace
		local moving = tern.kv.get("moving_tab")
		if moving then
			local cur_s = cx.sessions:current().id
			if n ~= cur_s then
				cx.sessions:switch(n)
			end
			local l = cx.session:layout(moving)
			if l and l.root then
				local panes_to_move = {}
				local function collect(t: TabTree?)
					if not t then return end
					if t.pane and not model.is_mine(cx, t.pane) then
						table.insert(panes_to_move, t.pane)
					end
					collect(t[1])
					collect(t[2])
				end
				collect(l.root)
				for _, p in panes_to_move do
					cx.layout:move_to_new_tab(p, n, { focus = false })
				end
			end
			tern.kv.set("moving_tab", nil)
		end
	elseif kind == "ren" and n then
		if cx.sessions:current().id ~= n then
			cx.sessions:switch(n)
		end
		cx:command("rename_session")
	elseif kind == "close" and n then
		for _, s in cx.sessions:list() do
			if s.id == n and not s.locked then
				cx.sessions:close(n)
				break
			end
		end
	elseif kind == "close_group" and n then
		-- herdr closes the whole group: the parent plus every nested checkout, minus the
		-- locked ones (the lock is the plugin's only safeguard). Children first, parent last.
		local ids = model.group_close_ids(cx, n)
		for _, id in ids.close do
			cx.sessions:close(id)
		end
		if #ids.kept > 0 then
			cx:toast("info", "Closed " .. #ids.close .. " workspaces, kept " .. #ids.kept .. " locked")
		else
			cx:toast("info", "Closed " .. #ids.close .. " workspaces")
		end
	elseif kind == "close_tab" and n then
		layout_mod.close_tab(cx, n)
	elseif kind == "new_tab" and n then
		-- Create tab in designated workspace
		local cur_s = cx.sessions:current().id
		if n ~= cur_s then
			cx.sessions:switch(n)
		end
		local cwd = get_session_cwd(cx, n)
		cx.layout:new_tab({ cwd = cwd }, { focus = true })
	elseif kind == "new" then
		-- Smart workspace creation with context inheritance
		local cwd, name = current_context(cx)
		cx.sessions:create({ name = name, cwd = cwd })
	elseif kind == "tab" and n then
		local target_tab: TabInfo? = nil
		for _, t in cx.session:tabs() do
			if t.id == n then
				target_tab = t
				break
			end
		end

		if target_tab then
			last_row_click = tern.now()
			-- No cleanup touches the tab this click moves to until the switch has settled.
			model.protect_tab(n, PROTECT_MS)
			-- A tab without its rail yet gets it now, before the switch: the user clicked a
			-- row in a rail and must land on a tab that has one (measured: a tab the mount
			-- ahead had not reached showed with no sidebar, read as "the sidebar closed").
			if tern.kv.get("pinned") and cx.session:layout(n) ~= nil and not (model.tab_has_sidebar(cx, n)) then
				pcall(open, cx, n, false)
			end
			local cur_s = cx.sessions:current().id
			if target_tab.session ~= cur_s then
				cx.sessions:switch(target_tab.session)
			end
			local dest_term = layout_mod.find_tab_terminal(cx, model.is_mine, n) or target_tab.pane
			if dest_term then
				cx.layout:focus(dest_term)
			end
		end
	else
		return nil
	end

	-- No forced repaint: the fingerprints say which rails the click changed.
	model.invalidate()
	refresh(cx)
	return true
end

tern.on("canvas_action", canvas_action)

--- The poll's two halves run on their own timers, 125 ms apart, so one call either reads
--- or repaints and never both. That split is the point: a call that read git *and*
--- repainted a tree is how this plugin passed its 50 ms budget, and the budget is per
--- call, so the two halves can only be safe apart.
local READ_MS = 250
local handoff_wired = false
local PAINT_MS = 250

--- Read tick: the I/O tick — the agent poll, the chime it earns, the daemon `ensure`
--- it may need, and one git read, never two. The budget is per hook and a spawn is
--- its expensive half, so a tick that starts the player — or the daemon — leaves the
--- git read for the next tick (which finds no new move and takes it). The poll is
--- the only place this plugin reads `cx.agents:list`, and the chime rides here
--- rather than in a paint because playing it spawns a process, which no paint tick may do.
--- The git read is a file read (the checkout) or a `cx.git:repo` query (ahead/behind),
--- never a process, and still one per call. Seven sessions cost seven ticks (about
--- 1.75 s) to fill in, and each answer repaints on a later paint tick, through the
--- fingerprint's generation counter.
local function read_tick(cx: WindowCx?)
	tern.timer(READ_MS, read_tick)
	-- The first tick only compiles: `model` (with worktrees, git and group) on its first
	-- touch here, and the bridge (`runtime.luau`) in `warmup`. Compile plus I/O in one
	-- hook does not fit the budget, so this tick polls, plays, ensures and reads nothing.
	if model.warmup() or not cx then
		return
	end
	-- The daemon plays the chimes when it is live (see `sound.set_handoff`): wired here,
	-- once, because touching `model` at load would compile it in the load hook.
	if not handoff_wired then
		handoff_wired = true
		sound.set_handoff(model.hand_chime)
	end
	-- Poll, judge and play in this one invocation, before the git read: the read tick is
	-- what hears an agent move. Nothing here waits for a repaint, and whether the rail is
	-- mounted or has been repainted does not enter into it. The flush is ahead of the early
	-- return below, so a chime never waits on a git read being stale. Failures log at
	-- warn: a silent poll is how a `?` goes missing with no trace in tern.log.
	local ok_moves, moves = pcall(model.poll_agents, cx)
	if not ok_moves then
		pcall(tern.log.warn, "ws poll_agents failed: " .. tostring(moves))
	elseif moves then
		pcall(sound.observe, moves)
	end
	local ok_played, played = pcall(sound.flush)
	model.invalidate()
	if ok_played and played == true then
		-- The hook's budget is per call, and the player was this call's one spawn: the git
		-- read waits for the next tick, which finds no new move to judge and takes it.
		return
	end
	-- The daemon the snapshot comes from: one `ensure` spawn when the poll's read went
	-- stale, in the same one-spawn seat the player left empty. A tick that ensures
	-- leaves the git read for the next tick, the same way a tick that played does.
	-- Through the model's helper: window.luau never requires the bridge itself, so
	-- the load hook never pays its compile.
	local ok_ensured, ensured = pcall(model.ensure_runtime)
	if ok_ensured and ensured == true then
		return
	end
	local ok, read = pcall(model.next_read, cx)
	if not ok or not read then
		return
	end
	if read.cwd ~= nil then
		pcall(worktrees.info_for, read.cwd)
	elseif read.root ~= nil then
		pcall(worktrees.head_for, cx, read.root)
	end
end

--- Whether the read tick has compiled `model` yet (the proxy fetched its first name).
local function model_warm(): boolean
	return rawget(model :: any, "warmup") ~= nil
end
local rail_warm = false

--- A hook that came close to its budget says so in tern.log, with its time.
local function slow(what: string)
	local spent = tern.now() - hook_started
	if spent > 30 then
		pcall(tern.log.warn, "ws slow " .. what .. ": " .. tostring(math.floor(spent)) .. " ms")
	end
end

--- Paint tick: the cheap passes and the redraw, all from the caches the read ticks fill.
--- It never starts a read (`model.next_read` belongs to `read_tick`), never spawns a
--- process, and therefore stays cheap no matter how slow git is being.
local function paint_tick(cx: WindowCx?)
	tern.timer(PAINT_MS, paint_tick)
	-- Until the read tick has compiled `model`, a paint would pay that compile plus the
	-- rail's modules plus a whole build in one hook: it waits. The first paint after
	-- that compiles the rail's own modules and draws nothing.
	if not rail_warm then
		if model_warm() then
			rail_warm = true
			local _ = view_mod.build, layout_mod.target_ratio, format.path
		end
		return
	end
	if not cx then
		return
	end
	hook_started = tern.now()
	model.invalidate()
	-- ensure_pinned runs the cleanups (dedup, auto-close) too: once per hook is enough.
	pcall(ensure_pinned, cx)
	-- One rail mounted ahead in a tab that has none, so no visit finds it missing.
	pcall(premount, cx)

	-- Update the chrome snapshot for the pure status formatter
	local ok, cur = pcall(function() return cx.sessions:current() end)
	local new_name = if ok and cur then cur.name else nil
	if new_name and (not chrome_snapshot or chrome_snapshot.name ~= new_name) then
		chrome_snapshot = cur
		tern.chrome.refresh()
	end

	pcall(refresh, cx)
	slow("paint")
end

tern.timer(100, read_tick)
tern.timer(225, paint_tick)

--- One window event's worth of work: mount/sync the rail on the tab the window is on now,
--- then repaint from the caches. Git reads belong to the read tick — a hook that starts one
--- can pass its 50 ms budget and get disabled, and a disabled hook is a frozen rail that
--- also stops answering clicks. Every handler below goes through here, which is why losing
--- this function once broke the rail on every tab switch without breaking the ticks.
local function on_window_change(cx: WindowCx)
	-- Before the paint tick has compiled the rail's modules, a window event would pay that
	-- compile and a whole build in one hook (measured: `window_start` passed 50 ms on a cold
	-- window and was disabled). The paint tick mounts and draws a moment later.
	if not rail_warm then
		return
	end
	hook_started = tern.now()
	-- No forced repaint: each rail's fingerprint says whether it changed, and a switch
	-- between tabs changes none (each rail already shows its own tab).
	model.invalidate()
	pcall(ensure_pinned, cx)
	pcall(refresh, cx)
	slow("window event")
end

tern.on("window_start", function(cx: WindowCx)
	on_window_change(cx)
end)

tern.on("pane_closed", function(_ev: PaneEvent, cx: WindowCx)
	on_window_change(cx)
end)

tern.on("tab_created", function(_ev: TabEvent, cx: WindowCx)
	on_window_change(cx)
end)

tern.on("tab_closed", function(_ev: TabEvent, cx: WindowCx)
	on_window_change(cx)
end)

tern.on("focus", function(ev: any, cx: WindowCx)
	refocus_terminal(ev, cx)
	local tab_id = ev and ev.tab
	if tab_id then
		local l = cx.session:layout(tab_id)
		if l and l.root and l.root[1] and l.root.ratio then
			local p = l.root[1].pane
			if p and model.is_mine(cx, p) then
				local cur_r = l.root.ratio
				local prev_known = layout_mod.known_ratio(tab_id)
				if prev_known and math.abs(cur_r - prev_known) > 0.015 and cur_r >= 0.05 and cur_r <= 0.60 then
					tern.kv.set("sidebar_ratio", cur_r)
				end
				layout_mod.set_known_ratio(tab_id, cur_r)
			end
		end
	end
	on_window_change(cx)
end)

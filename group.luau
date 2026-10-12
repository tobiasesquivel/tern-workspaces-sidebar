--!strict
-- Pure rail grouping: turns the session list into the rows the sidebar draws, and
-- answers the fold and close questions about those rows.
-- No cx, no tern globals, no dependency on any other module: the test host
-- loadstring's this file standalone.

local group = {}

--- One session as the rail sees it: its id, the repo it sits in, and whether it is a
--- linked worktree rather than the repo's main checkout.
export type Item = {
	id: number,
	--- Repo identity every checkout of the same repo shares; nil outside git.
	repo_key: string?,
	--- True for a linked worktree checkout, false for a main one (and for non-repos).
	linked: boolean,
}

--- One drawn row. Depth is 0 or 1 because a linked checkout can never host a nested
--- worktree of the same repo: git's layout stops at one level, so the rail does too.
export type Row = {
	id: number,
	--- 0 for a top-level row, 1 for a worktree nested under its repo's session.
	depth: number,
	--- How many rows are drawn under this one; 0 for anything that is not a parent.
	children: number,
	--- Session id this row hangs under; nil for a top-level row.
	parent: number?,
}

--- The rail's rows: each repo's main checkout leads and its worktrees follow.
---
--- The first non-linked session of a repo in `items` is that repo's group parent; every
--- linked session with the same key becomes its child, in input order, no matter where
--- the parent sits in the list. Everything else keeps its input position: a linked
--- session whose repo has no session open stays top-level, and a second non-linked
--- session of the same repo is an ordinary row, never a second parent.
---
--- Depth stops at 1 because a linked checkout cannot host a nested worktree of the same
--- repo — git's own layout is one level deep — so there is nothing below a child to
--- model, and a row's parent chain is at most one step long.
function group.arrange(items: { Item }): { Row }
	-- Which session parents which repo. The first main checkout in input order wins.
	local parent_of: { [string]: number } = {}
	for _, it in items do
		local key = it.repo_key
		if key ~= nil and not it.linked and parent_of[key] == nil then
			parent_of[key] = it.id
		end
	end

	-- The children of each parent, in input order.
	local kids: { [number]: { number } } = {}
	local nested: { [number]: boolean } = {}
	for _, it in items do
		local key = it.repo_key
		if it.linked and key ~= nil then
			local pid = parent_of[key]
			if pid ~= nil then
				local list = kids[pid]
				if not list then
					list = {}
					kids[pid] = list
				end
				table.insert(list, it.id)
				nested[it.id] = true
			end
		end
	end

	local rows: { Row } = {}
	for _, it in items do
		if nested[it.id] then
			continue -- already drawn under its parent
		end
		local key = it.repo_key
		local list = if key ~= nil and parent_of[key] == it.id then kids[it.id] else nil
		local row: Row = { id = it.id, depth = 0, children = if list then #list else 0, parent = nil }
		table.insert(rows, row)
		if list then
			for _, cid in list do
				local child: Row = { id = cid, depth = 1, children = 0, parent = it.id }
				table.insert(rows, child)
			end
		end
	end
	return rows
end

--- Which rows are folded. Every row starts expanded, so a workspace shows its tabs
--- until the user folds it: only an explicit value (a kv the user set) folds a row.
--- One row overrides the user: an ancestor of the current session stays open, because
--- the current row hangs under it and the rail must always show where the window is.
--- The current row itself folds like any other.
---
--- Depth stops at 1 here too (see `group.arrange`), so the ancestor chain is at most
--- the row itself plus its parent.
function group.folded(
	rows: { Row },
	explicit: { [number]: boolean? },
	current: number?
): { [number]: boolean }
	local parent_of: { [number]: number? } = {}
	for _, r in rows do
		if r.parent ~= nil then
			parent_of[r.id] = r.parent
		end
	end

	local open: { [number]: boolean } = {}
	local walk = current
	while walk ~= nil and not open[walk] do
		open[walk] = true
		walk = parent_of[walk]
	end

	local out: { [number]: boolean } = {}
	for _, r in rows do
		out[r.id] = explicit[r.id] == true
	end
	-- An ancestor of the current session stays open: the current row hangs under it, and
	-- the rail must always show where the window is. The current row itself folds like any
	-- other — that is how the user collapses the list they are working in.
	for id in open do
		if id ~= current then
			out[id] = false
		end
	end
	return out
end

--- What `Close group` closes: the `root` session plus every row nested under it.
--- Locked members are held back in `kept` instead of `close`. Both lists put the
--- descendants first in row order and `root` last, so the caller can close the
--- children before their parent.
---
--- Depth stops at 1 (see `group.arrange`), so "every row under root" is exactly the
--- root's children.
function group.close_set(
	rows: { Row },
	root: number,
	locked: { [number]: boolean }
): { close: { number }, kept: { number } }
	local parent_of: { [number]: number? } = {}
	for _, r in rows do
		if r.parent ~= nil then
			parent_of[r.id] = r.parent
		end
	end

	local close: { number } = {}
	local kept: { number } = {}
	for _, r in rows do
		if r.id == root then
			continue
		end
		local at = parent_of[r.id]
		while at ~= nil do
			if at == root then
				local member = if locked[r.id] then kept else close
				table.insert(member, r.id)
				break
			end
			at = parent_of[at]
		end
	end
	local root_member = if locked[root] then kept else close
	table.insert(root_member, root)
	return { close = close, kept = kept }
end

return group

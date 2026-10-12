--!strict
-- Worktree access: cached git reads plus the create/remove operations.
-- Pure parsing, naming and process-result helpers live in git.luau; this module only
-- talks to git and keeps the answers.
--
-- Discipline (50 ms per handler): process callbacks never draw. They update these
-- caches and bump a generation counter, and the sidebar's poll redraws when the
-- generation changes. Reads are single-flight per key and concurrent waiters share
-- one git run, so a 250 ms poll can never stack up processes.

local git = require("./git")

local worktrees = {}

--- How long a cached answer stays fresh. herdr refreshes git state at 1500 ms.
local TTL_MS = 3000
--- How long an answer survives once it is no longer fresh: a stale answer is still what
--- the rail draws, so it outlives the TTL. Only cwds no session has reported for this long
--- (an old `cd`) are dropped.
local KEEP_MS = 10 * TTL_MS
--- git calls are local and fast; a hung one must not pin a slot forever.
local TIMEOUT_MS = 15000

export type Info = {
	--- The cwd the answer came from.
	cwd: string,
	--- Checkout root containing that cwd.
	root: string,
	--- Shared git dir; <root>/.git for the main checkout.
	common_dir: string,
	--- Repo identity: the common git dir, lowercased.
	repo_key: string,
	repo_name: string,
	--- The main checkout of the repo.
	main_checkout: string,
	--- True when this checkout is a linked worktree, not the main one.
	linked: boolean,
	branch: string?,
}

--- What one `cx.git:repo` answer says about the branch's upstream.
export type Head = {
	--- Commits the branch has that the upstream does not.
	ahead: number,
	--- Commits the upstream has that the branch does not.
	behind: number,
	--- Upstream ref name, e.g. "origin/main"; nil when the branch has none.
	upstream: string?,
}

local cwd_cache: { [string]: { at: number, value: Info? } } = {}
local cwd_inflight: { [string]: boolean } = {}
local list_cache: { [string]: { at: number, value: { git.Worktree } } } = {}
local list_waiters: { [string]: { ((list: { git.Worktree }?, cx: WindowCx?) -> ()) } } = {}
local dirty_cache: { [string]: { at: number, value: number } } = {}
local dirty_waiters: { [string]: { ((count: number, cx: WindowCx?) -> ()) } } = {}
local head_cache: { [string]: { at: number, value: Head? } } = {}
local head_inflight: { [string]: boolean } = {}

--- Bumped whenever a cached answer changes; the sidebar folds it into its fingerprint.
local generation = 0

local function now(): number
	return tern.now()
end

--- Cache key for a path: git compares paths case-insensitively on Windows, and the
--- same checkout can arrive spelled two ways.
local function key_of(path: string): string
	return string.lower(git.normalize(path))
end

local function is_fresh(entry: { at: number }?): boolean
	return entry ~= nil and (now() - entry.at) < TTL_MS
end

function worktrees.generation(): number
	return generation
end

function worktrees.invalidate()
	cwd_cache = {}
	list_cache = {}
	dirty_cache = {}
	head_cache = {}
	generation += 1
end

local function run(argv: { string }, cwd: string, cb: (result: tern.ProcessResult, cx: WindowCx?) -> ())
	local ok = pcall(function()
		tern.process.run(argv, { cwd = cwd, env = { ["LC_ALL"] = "C" }, timeout_ms = TIMEOUT_MS }, cb)
	end)
	if not ok then
		cb({ status = -1, stdout = "", stderr = "could not run git", timed_out = false }, nil)
	end
end

local function same_info(a: Info?, b: Info?): boolean
	if a == nil or b == nil then
		return a == nil and b == nil
	end
	return a.root == b.root
		and a.branch == b.branch
		and a.linked == b.linked
		and a.repo_key == b.repo_key
		and a.common_dir == b.common_dir
end

local function same_head(a: Head?, b: Head?): boolean
	if a == nil or b == nil then
		return a == nil and b == nil
	end
	return a.ahead == b.ahead and a.behind == b.behind and a.upstream == b.upstream
end

-- Reads -----------------------------------------------------------------------

--- The cached worktree info for a cwd, or nil while nothing is known yet. A cache
--- read only: it never starts a process, so a draw may call it. Stale counts as a
--- value — the rail shows the last answer instead of a hole.
function worktrees.info_peek(cwd: string): Info?
	if cwd == "" then
		return nil
	end
	local entry = cwd_cache[key_of(cwd)]
	return if entry then entry.value else nil
end

--- Whether `info_for` would start a read for this cwd: no fresh answer and none in
--- flight. The poll asks this to pick the single read it does per tick.
function worktrees.info_stale(cwd: string): boolean
	if cwd == "" then
		return false
	end
	local key = key_of(cwd)
	return not is_fresh(cwd_cache[key]) and not cwd_inflight[key]
end

--- Cached worktree info for a cwd, read without waiting: the sidebar needs this
--- inside a draw. A stale or missing answer kicks a background refresh and the
--- value comes back on a later poll. nil means "not inside a git checkout" (also
--- cached, so a non-repo cwd costs nothing after the first look).
---
--- This is the version that starts a process: call it from the poll or from a user
--- action, never from a draw — one `git rev-parse` can cost more than a whole
--- window call budget on a cold cache.
function worktrees.info_for(cwd: string): Info?
	if cwd == "" then
		return nil
	end
	local key = key_of(cwd)
	local entry = cwd_cache[key]
	if is_fresh(entry) or cwd_inflight[key] then
		return entry and entry.value or nil
	end

	cwd_inflight[key] = true
	run({
		"git", "-C", cwd, "rev-parse", "--path-format=absolute",
		"--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD",
	}, cwd, function(res)
		cwd_inflight[key] = nil
		local parsed = if res.status == 0 then git.parse_rev_parse(res.stdout) else nil
		local value: Info? = nil
		if parsed then
			value = {
				cwd = git.normalize(cwd),
				root = parsed.toplevel,
				common_dir = parsed.common_dir,
				repo_key = git.repo_key(parsed.common_dir),
				repo_name = git.repo_name(parsed.common_dir),
				main_checkout = git.main_checkout(parsed.common_dir),
				linked = git.is_linked(parsed.toplevel, parsed.common_dir),
				branch = parsed.branch,
			}
		end
		local previous = cwd_cache[key]
		if not same_info(previous and previous.value or nil, value) then
			generation += 1
		end
		-- One entry per cwd a session ever reported (every `cd` adds one), so drop the
		-- ones nobody has asked about for a long time. Not the merely stale ones: a stale
		-- answer is still what the rail draws until its own read lands, and dropping it
		-- would blank another session's branch cell for a tick.
		for k, entry in cwd_cache do
			if now() - entry.at > KEEP_MS then
				cwd_cache[k] = nil
			end
		end
		cwd_cache[key] = { at = now(), value = value }
	end)

	return entry and entry.value or nil
end

local function same_list(a: { git.Worktree }, b: { git.Worktree }): boolean
	if #a ~= #b then
		return false
	end
	for i, w in a do
		if w.path ~= b[i].path or w.branch ~= b[i].branch or w.bare ~= b[i].bare then
			return false
		end
	end
	return true
end

--- The repo's worktree list, fetched if needed. cb runs once, and callers that
--- arrive while a fetch is in flight share it instead of starting another. `cx` is
--- the fresh context of the process hook when the list was just read, and nil when
--- it came from the cache — a WindowCx does not survive the hook that got it, so a
--- callback that touches the window must use this one, not the one it captured.
function worktrees.list(main_checkout: string, cb: (list: { git.Worktree }?, cx: WindowCx?) -> ())
	local root = git.normalize(main_checkout)
	local key = key_of(root)
	local entry = list_cache[key]
	if is_fresh(entry) then
		cb(entry.value, nil)
		return
	end

	local waiters = list_waiters[key]
	if waiters then
		table.insert(waiters, cb)
		return
	end
	list_waiters[key] = { cb }

	run({ "git", "-C", root, "worktree", "list", "--porcelain" }, root, function(res, cx)
		local pending = list_waiters[key] or {}
		list_waiters[key] = nil
		local value: { git.Worktree }? = nil
		if res.status == 0 then
			value = git.parse_worktree_list(res.stdout)
			local previous = list_cache[key]
			if not previous or not same_list(previous.value, value) then
				generation += 1
			end
			list_cache[key] = { at = now(), value = value }
		end
		for _, waiter in pending do
			waiter(value, cx)
		end
	end)
end

--- Cached count of changed paths in a checkout (untracked included). -1 means the
--- git call failed, e.g. the checkout is already gone. `cx` follows the same rule as
--- `list`: the fresh context of the process hook when the count was just read, nil
--- when it came from the cache.
function worktrees.dirty(path: string, cb: (count: number, cx: WindowCx?) -> ())
	local norm = git.normalize(path)
	local key = key_of(norm)
	local entry = dirty_cache[key]
	if is_fresh(entry) then
		cb(entry.value, nil)
		return
	end

	local waiters = dirty_waiters[key]
	if waiters then
		table.insert(waiters, cb)
		return
	end
	dirty_waiters[key] = { cb }

	run({ "git", "-C", norm, "status", "--porcelain", "--untracked-files=all" }, norm, function(res, cx)
		local pending = dirty_waiters[key] or {}
		dirty_waiters[key] = nil
		local count = if res.status == 0 then git.dirty_count(res.stdout) else -1
		dirty_cache[key] = { at = now(), value = count }
		for _, waiter in pending do
			waiter(count, cx)
		end
	end)
end

--- The cached ahead/behind for a checkout root, or nil while nothing is known yet.
--- A cache read only, so a draw may call it; stale counts as a value.
function worktrees.head_peek(root: string): Head?
	if root == "" then
		return nil
	end
	local entry = head_cache[key_of(root)]
	return if entry then entry.value else nil
end

--- Whether `head_for` would register a read for this root. The poll asks this to
--- pick the single read it does per tick.
function worktrees.head_stale(root: string): boolean
	if root == "" then
		return false
	end
	local key = key_of(root)
	return not is_fresh(head_cache[key]) and not head_inflight[key]
end

--- Cached ahead/behind against the branch's upstream, read without waiting so a draw
--- can call it. A stale or missing entry kicks one background read and returns the
--- stale value (or nil) meanwhile; the fresh answer lands on a later poll.
--- nil means "no answer": not a repo, no git engine, or the read failed. That too is
--- cached for TTL_MS, so a path that cannot answer costs nothing while fresh and the
--- read is never retried in a loop.
---
--- Registering the read is cheap, but it is still a git-engine call from a window
--- hook: the poll owns it, and a draw uses `head_peek` instead.
---
--- This goes through cx.git:repo instead of `git rev-list --left-right --count
--- HEAD...@{u}`: Tern's own engine already resolves the branch's upstream, so there is
--- nothing to parse and no branch name to escape. TTL_MS is this module's single
--- 3000 ms for rail git reads; herdr refreshes ahead/behind at 1500 ms
--- (GIT_REMOTE_STATUS_REFRESH_INTERVAL) — a deliberate deviation, every rail repaint
--- would otherwise ask for a fresh read.
function worktrees.head_for(cx: WindowCx, root: string): Head?
	local key = key_of(root)
	local entry = head_cache[key]
	if is_fresh(entry) or head_inflight[key] then
		return entry and entry.value or nil
	end

	-- The awaitable callback is the only writer. Registering the read can raise (no
	-- git engine in this VM), and that raise must land as "no answer" rather than
	-- leave the key in flight forever.
	local function land(value: Head?)
		if not head_inflight[key] then
			return
		end
		head_inflight[key] = nil
		local previous = head_cache[key]
		if not same_head(previous and previous.value or nil, value) then
			generation += 1
		end
		head_cache[key] = { at = now(), value = value }
	end

	head_inflight[key] = true
	local ok = pcall(function()
		cx.git:repo(root):next(function(repo, _err, _cx2)
			if repo then
				land({ ahead = repo.ahead, behind = repo.behind, upstream = repo.upstream })
			else
				land(nil)
			end
		end)
	end)
	if not ok then
		land(nil)
	end

	return entry and entry.value or nil
end

-- Mutations --------------------------------------------------------------------

--- Create a worktree. With an existing local branch it checks that branch out;
--- otherwise it creates one from `base`. Mirrors herdr's argv exactly: no --force,
--- no -B, no fetch, and no branch deletion anywhere.
function worktrees.create(
	main_checkout: string,
	branch: string,
	path: string,
	base: string,
	cb: (err: string?, cx: WindowCx?) -> ()
)
	local root = git.normalize(main_checkout)
	local target = git.normalize(path)
	run({ "git", "-C", root, "show-ref", "--verify", "--quiet", "refs/heads/" .. branch }, root, function(res)
		local argv: { string }
		if res.status == 0 then
			argv = { "git", "-C", root, "worktree", "add", target, branch }
		else
			argv = { "git", "-C", root, "worktree", "add", "-b", branch, target, base }
		end
		pcall(function()
			tern.fs.mkdir(git.parent(target))
		end)
		run(argv, root, function(add, cx)
			list_cache[string.lower(root)] = nil
			cwd_cache = {}
			generation += 1
			if add.status == 0 then
				cb(nil, cx)
			else
				cb(git.error_text(add), cx)
			end
		end)
	end)
end

--- Remove a worktree checkout. The branch is never deleted and no prune is run
--- (herdr does neither). git itself refuses a dirty checkout unless force is set.
function worktrees.remove(
	main_checkout: string,
	path: string,
	force: boolean,
	cb: (err: string?, cx: WindowCx?) -> ()
)
	local root = git.normalize(main_checkout)
	local target = git.normalize(path)
	local argv: { string } = { "git", "-C", root, "worktree", "remove" }
	if force then
		table.insert(argv, "--force")
	end
	table.insert(argv, target)
	run(argv, root, function(res, cx)
		list_cache[string.lower(root)] = nil
		cwd_cache = {}
		dirty_cache[string.lower(target)] = nil
		generation += 1
		if res.status == 0 then
			cb(nil, cx)
		else
			cb(git.error_text(res), cx)
		end
	end)
end

local function exists(path: string): boolean
	local ok, found = pcall(function()
		return tern.fs.exists(path)
	end)
	return ok and found == true
end

--- The first free checkout path: skips the repo's checkouts and any folder already
--- on disk, since git itself has no collision handling (herdr lets git fail).
function worktrees.free_path(desired: string, taken: { [string]: boolean }): string
	for n = 1, 99 do
		local candidate = if n == 1 then desired else desired .. "-" .. n
		if not taken[string.lower(git.normalize(candidate))] and not exists(candidate) then
			return candidate
		end
	end
	return desired
end

return worktrees

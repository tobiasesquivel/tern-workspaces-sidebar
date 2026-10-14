--!strict
-- Worktree access: cached git reads plus the create/remove operations.
-- Pure parsing, naming and process-result helpers live in git.luau; this module only
-- talks to git and keeps the answers.
--
-- Discipline (50 ms per handler): process callbacks never draw. They update these
-- caches and bump a generation counter, and the sidebar's poll redraws when the
-- generation changes. The checkout of a cwd is read from git's own files, as herdr
-- does, never by running git; the reads that do run git (list, dirty, create, remove)
-- are single-flight per key, so a 250 ms poll can never stack up processes.

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

--- `GIT_OPTIONAL_LOCKS=0`: a `git status` must not refresh `.git/index`. Tern watches a linked
--- plugin's tree, so that write in this repo reloads the plugin that caused it.
local function run(argv: { string }, cwd: string, cb: (result: tern.ProcessResult, cx: WindowCx?) -> ())
	local ok = pcall(function()
		tern.process.run(argv, { cwd = cwd, env = { ["LC_ALL"] = "C", ["GIT_OPTIONAL_LOCKS"] = "0" }, timeout_ms = TIMEOUT_MS }, cb)
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

--- Whether `info_for` would read this cwd again: no fresh answer. The poll asks this to
--- pick the single read it does per tick.
function worktrees.info_stale(cwd: string): boolean
	if cwd == "" then
		return false
	end
	return not is_fresh(cwd_cache[key_of(cwd)])
end

--- The checkout holding `start`, found the way herdr finds it (`git_repo_root` and
--- `git_dir_for_repo_root`, `src/workspace/git/discovery.rs`): walk up from `start` to
--- the first directory whose `.git` is a git dir — a `.git` directory, or a `.git` file
--- naming one — that holds a `HEAD`. An invalid marker does not count and the walk goes
--- on. Returns the checkout root and its git dir, or nil outside any checkout.
local function discover(start: string): (string?, string?)
	local dir = git.normalize(start)
	while dir ~= "" do
		local marker = dir .. "/.git"
		if string.sub(dir, -1) == "/" then
			marker = dir .. ".git"
		end
		if tern.fs.exists(marker) then
			-- A directory raises on a bounded read (regular files only), so a read that
			-- answers is the `.git` file of a linked checkout or a submodule.
			local ok, text = pcall(tern.fs.read, marker, 4096)
			local git_dir: string? = nil
			if ok and type(text) == "string" then
				local pointed = git.parse_gitdir_file(text)
				if pointed then
					git_dir = git.resolve(dir, pointed)
				end
			elseif not ok then
				git_dir = git.normalize(marker)
			end
			if git_dir and tern.fs.exists(git_dir .. "/HEAD") then
				return dir, git_dir
			end
		end
		local up = git.parent(dir)
		if up == dir or up == "" then
			break
		end
		dir = up
	end
	return nil, nil
end

--- A small file's text, or nil when it is missing or unreadable.
local function read_small(path: string): string?
	local ok, text = pcall(tern.fs.read, path, 4096)
	return if ok and type(text) == "string" then text else nil
end

--- The worktree info of a cwd from the files git keeps, the way herdr reads it
--- (`git_worktree_info`): the common dir is `<git dir>/commondir` resolved, or the git
--- dir itself; the branch is what `<git dir>/HEAD` names, nil when detached. nil
--- outside any checkout.
local function read_info(cwd: string): Info?
	local root, git_dir = discover(cwd)
	if root == nil or git_dir == nil then
		return nil
	end
	local common_text = read_small(git_dir .. "/commondir")
	local pointed = if common_text then string.match(common_text, "^[^%c]*") else nil
	local common_dir = if pointed and pointed ~= "" then git.resolve(git_dir, pointed) else git_dir
	local head = read_small(git_dir .. "/HEAD")
	return {
		cwd = git.normalize(cwd),
		root = git.normalize(root),
		common_dir = common_dir,
		repo_key = git.repo_key(common_dir),
		repo_name = git.repo_name(common_dir),
		main_checkout = git.main_checkout(common_dir),
		linked = git.is_linked(root, common_dir),
		branch = if head then git.parse_head(head) else nil,
	}
end

--- Cached worktree info for a cwd. A stale or missing answer is read again on the spot
--- from git's own files — no process: a spawn from a window hook costs 2 to 70 ms on
--- Windows, and one past 50 ms disables every timer of the plugin. nil means "not
--- inside a git checkout" (also cached, so a non-repo cwd costs nothing while fresh).
---
--- This is the version that reads the disk: call it from the read tick or from a user
--- action, never from a draw, which uses `info_peek`.
function worktrees.info_for(cwd: string): Info?
	if cwd == "" then
		return nil
	end
	local key = key_of(cwd)
	local entry = cwd_cache[key]
	if is_fresh(entry) then
		return entry and entry.value or nil
	end

	local ok, value = pcall(read_info, cwd)
	local info: Info? = if ok then value else nil
	if not same_info(entry and entry.value or nil, info) then
		generation += 1
	end
	-- One entry per cwd a session ever reported (every `cd` adds one), so drop the
	-- ones nobody has asked about for a long time. Not the merely stale ones: a stale
	-- answer is still what the rail draws until its own read lands, and dropping it
	-- would blank another session's branch cell for a tick.
	for k, old in cwd_cache do
		if now() - old.at > KEEP_MS then
			cwd_cache[k] = nil
		end
	end
	cwd_cache[key] = { at = now(), value = info }
	return info
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

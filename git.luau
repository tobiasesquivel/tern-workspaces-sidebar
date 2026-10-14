--!strict
-- Pure git helpers for worktrees: porcelain and rev-parse parsing, naming, path math,
-- and the interpretation of git's process results (error text, force cases, taken paths).
-- No cx, no I/O: every function here is testable in isolation.
-- The stateful side (process calls, caching) lives in worktrees.luau.
--
-- Naming and command shapes mirror herdr (github.com/herdrdev/herdr, src/worktree.rs),
-- with one deliberate difference: checkouts are siblings of the repo named
-- <repo>-<branch leaf> instead of under ~/.herdr/worktrees/<repo>/<full slug>,
-- because that is the layout this machine already has.

local git = {}

export type Worktree = {
	--- Absolute checkout path, forward slashes.
	path: string,
	--- HEAD commit.
	head: string?,
	--- Short branch name; nil when detached.
	branch: string?,
	detached: boolean,
	bare: boolean,
	prunable: boolean,
	locked: boolean,
}

--- What one `git rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD` says.
export type RepoInfo = {
	--- Checkout root of the cwd (the worktree root when the cwd is inside one).
	toplevel: string,
	--- Shared git dir; equal to <toplevel>/.git for the main checkout.
	common_dir: string,
	--- Short branch name; nil when HEAD is detached.
	branch: string?,
}

-- Paths -------------------------------------------------------------------

--- Backslashes to forward slashes, no trailing separator.
--- A bare drive keeps its slash: "C:" alone means "the cwd on C:".
function git.normalize(p: string): string
	local s = string.gsub(p, "\\", "/")
	while #s > 1 and string.sub(s, -1) == "/" do
		s = string.sub(s, 1, #s - 1)
	end
	if string.match(s, "^%a:$") then
		return s .. "/"
	end
	return s
end

--- Parent directory of a path; "" for a bare name, "/" or "C:/" for a root.
function git.parent(p: string): string
	local s = git.normalize(p)
	local head = string.match(s, "^(.*)/[^/]*$")
	if not head then
		return ""
	end
	if head == "" then
		return "/"
	end
	if string.match(head, "^%a:$") then
		return head .. "/"
	end
	return head
end

--- Last path segment.
function git.base_name(p: string): string
	local s = git.normalize(p)
	return string.match(s, "([^/]*)$") or s
end

--- Case-insensitive equality: Windows paths differ in case between sources.
function git.equal_path(a: string, b: string): boolean
	return string.lower(git.normalize(a)) == string.lower(git.normalize(b))
end

--- Whether `child` is `parent` or sits under it (case-insensitive, separator-aware).
function git.is_inside(child: string, parent: string): boolean
	local c = string.lower(git.normalize(child))
	local p = string.lower(git.normalize(parent))
	if p == "" then
		return false
	end
	if c == p then
		return true
	end
	return string.sub(c, 1, #p + 1) == p .. "/"
end

-- Branch and checkout naming -------------------------------------------------

--- Last segment of a branch name: "feat/notifications" -> "notifications".
function git.branch_leaf(branch: string): string
	local s = git.normalize(branch)
	return string.match(s, "([^/]*)$") or s
end

--- herdr's branch_to_path_slug: lowercase, runs of non-alphanumerics become one
--- dash, dashes trimmed, empty becomes "worktree".
function git.slug(s: string): string
	local out = string.gsub(s, "%W+", "-")
	out = string.lower(out)
	out = string.gsub(out, "^-+", "")
	out = string.gsub(out, "-+$", "")
	if out == "" then
		return "worktree"
	end
	return out
end

--- Make a string safe as one path segment on Windows and POSIX.
function git.sanitize_segment(s: string): string
	local out = string.gsub(s, '[<>:"/\\|?*%c]', "-")
	out = string.gsub(out, "%-+", "-")
	out = string.gsub(out, "^[%.%-%s]+", "")
	out = string.gsub(out, "[%.%s]+$", "")
	return out
end

--- The checkout path convention: a sibling of the repo named <repo>-<branch leaf>.
--- E.g. the repo `app` on branch `feat/login` checks out beside it as `app-login`.
function git.checkout_path(repo_root: string, branch: string): string
	local root = git.normalize(repo_root)
	local name = git.slug(git.base_name(root))
	local leaf = git.slug(git.branch_leaf(branch))
	local dir = git.parent(root)
	if dir == "" then
		return name .. "-" .. leaf
	end
	if dir == "/" then
		return "/" .. name .. "-" .. leaf
	end
	return dir .. "/" .. name .. "-" .. leaf
end

local ADJECTIVES = { "brave", "calm", "clear", "green", "lucky", "quiet", "rapid", "silver" }
local NOUNS = { "river", "cloud", "field", "forest", "harbor", "meadow", "stone", "valley" }

--- herdr's generated_branch_slug: worktree/<adjective>-<noun>-<hex4>.
function git.generated_branch(seed: number): string
	local n = #ADJECTIVES
	local s = math.floor(math.abs(seed))
	local adjective = ADJECTIVES[(s % n) + 1]
	local noun = NOUNS[(math.floor(s / n) % n) + 1]
	return string.format("worktree/%s-%s-%04x", adjective, noun, s % 0x10000)
end

-- Repo identity ---------------------------------------------------------------

--- Repo display name, following herdr: the name of the directory holding the
--- common git dir when that is .git or .bare, else the common dir's own name.
function git.repo_name(common_dir: string): string
	local base = git.base_name(common_dir)
	if base == ".git" or base == ".bare" then
		local container = git.base_name(git.parent(common_dir))
		if container ~= "" and container ~= "/" then
			return container
		end
	elseif base ~= "" then
		return base
	end
	return "repo"
end

--- The main checkout of the repo owning `common_dir`.
function git.main_checkout(common_dir: string): string
	local base = git.base_name(common_dir)
	if base == ".git" or base == ".bare" then
		return git.parent(common_dir)
	end
	return git.normalize(common_dir)
end

--- Repo identity key: the common git dir, compared case-insensitively.
function git.repo_key(common_dir: string): string
	return string.lower(git.normalize(common_dir))
end

--- Whether `toplevel` is a linked worktree rather than the main checkout.
function git.is_linked(toplevel: string, common_dir: string): boolean
	return not git.equal_path(toplevel, git.main_checkout(common_dir))
end

--- Whether a path is absolute: a drive (`C:/...`), a UNC or a POSIX root.
function git.is_absolute(p: string): boolean
	local s = git.normalize(p)
	return string.match(s, "^%a:/") ~= nil or string.sub(s, 1, 1) == "/"
end

--- `rel` resolved against `base` (unless it is absolute) with `.` and `..` folded, the
--- way git resolves the paths in a `.git` file and in `commondir`.
function git.resolve(base: string, rel: string): string
	local joined = if git.is_absolute(rel) then git.normalize(rel) else git.normalize(base) .. "/" .. git.normalize(rel)
	local prefix = string.match(joined, "^%a:/") or (if string.sub(joined, 1, 2) == "//" then "//" elseif string.sub(joined, 1, 1) == "/" then "/" else "")
	local parts: { string } = {}
	for part in string.gmatch(string.sub(joined, #prefix + 1), "[^/]+") do
		if part == ".." then
			if #parts > 0 then
				table.remove(parts)
			end
		elseif part ~= "." then
			table.insert(parts, part)
		end
	end
	return git.normalize(prefix .. table.concat(parts, "/"))
end

-- Discovery files -----------------------------------------------------------
-- herdr finds a checkout by reading files, not by running git
-- (`src/workspace/git/discovery.rs`): a `.git` directory, or a `.git` file naming the
-- git dir; `<git dir>/commondir` naming the shared dir; `<git dir>/HEAD` naming the
-- branch. These parse the contents; worktrees.luau does the reads.

--- The git dir a `.git` file points at (`gitdir: <path>`), or nil when the text is not
--- one: herdr does not count an invalid marker as a checkout.
function git.parse_gitdir_file(text: string): string?
	local path = string.match(string.match(text, "^[^%c]*") or "", "^gitdir:%s*(.-)%s*$")
	if path == nil or path == "" then
		return nil
	end
	return path
end

--- The branch a `HEAD` file names (`ref: refs/heads/<name>`), or nil for a detached
--- HEAD (an object id) — herdr's `git_branch`, which `--abbrev-ref` matched before.
function git.parse_head(text: string): string?
	local name = string.match(string.match(text, "^[^%c]*") or "", "^ref:%s*refs/heads/(.-)%s*$")
	if name == nil or name == "" then
		return nil
	end
	return name
end

-- Parsing -------------------------------------------------------------------

--- Parse the three lines of
--- `git rev-parse --path-format=absolute --show-toplevel --git-common-dir --abbrev-ref HEAD`
--- (the branch line is "HEAD" when detached). Returns nil when the output
--- lacks either path, which is what a bare repo or a non-repo cwd produces.
function git.parse_rev_parse(text: string): RepoInfo?
	local lines: { string } = {}
	for line in string.gmatch(text, "([^\n]*)\n?") do
		if line ~= "" then
			table.insert(lines, line)
		end
	end
	if #lines < 2 then
		return nil
	end
	local branch: string? = lines[3]
	if branch == "HEAD" or branch == "" then
		branch = nil
	end
	return {
		toplevel = git.normalize(lines[1]),
		common_dir = git.normalize(lines[2]),
		branch = branch,
	}
end

--- Parse `git worktree list --porcelain`: blank-line separated records, each
--- starting with "worktree <path>" and carrying HEAD/branch/detached/bare/
--- prunable/locked keys. Value-less keys (detached, bare) are flags.
function git.parse_worktree_list(text: string): { Worktree }
	local out: { Worktree } = {}
	local current: Worktree? = nil

	local function push()
		if current then
			table.insert(out, current)
			current = nil
		end
	end

	for line in string.gmatch(text .. "\n", "([^\n]*)\n") do
		if line == "" then
			push()
		else
			local key, value = string.match(line, "^(%S+)%s*(.*)$")
			if key then
				if key == "worktree" and value ~= "" then
					push()
					current = {
						path = git.normalize(value),
						head = nil,
						branch = nil,
						detached = false,
						bare = false,
						prunable = false,
						locked = false,
					}
				elseif current then
					if key == "HEAD" then
						current.head = value
					elseif key == "branch" then
						current.branch = string.gsub(value, "^refs/heads/", "")
					elseif key == "detached" then
						current.detached = true
						current.branch = nil
					elseif key == "bare" then
						current.bare = true
					elseif key == "prunable" then
						current.prunable = true
					elseif key == "locked" then
						current.locked = true
					end
				end
			end
		end
	end
	push()
	return out
end

--- Worktrees a person can open: not bare, not prunable (herdr filters both).
function git.openable(list: { Worktree }): { Worktree }
	local out: { Worktree } = {}
	for _, w in list do
		if not w.bare and not w.prunable then
			table.insert(out, w)
		end
	end
	return out
end

--- Count changed paths in `git status --porcelain` output (untracked included).
function git.dirty_count(text: string): number
	local n = 0
	for line in string.gmatch(text, "([^\n]+)") do
		if string.match(line, "%S") then
			n += 1
		end
	end
	return n
end

-- Process results and checkout reconciliation ----------------------------------

--- git's message for the user: its stderr, minus the leading "fatal: ", one line.
function git.error_text(res: tern.ProcessResult): string
	local text = if res.stderr ~= "" then res.stderr else res.stdout
	text = string.gsub(text, "^fatal: ", "")
	text = string.gsub(text, "\n.*$", "")
	text = string.gsub(text, "%s+$", "")
	if text == "" then
		return "git failed (exit " .. tostring(res.status) .. ")"
	end
	return text
end

--- Whether git refused because the checkout has changes or submodules, which is
--- exactly the case its own --force overrides.
function git.needs_force(err: string?): boolean
	if not err then
		return false
	end
	local e = string.lower(err)
	return string.find(e, "contains modified or untracked files", 1, true) ~= nil
		or string.find(e, "containing submodules", 1, true) ~= nil
end

--- The paths that already exist as checkouts, lowercased for comparison.
function git.taken_paths(list: { Worktree }): { [string]: boolean }
	local taken: { [string]: boolean } = {}
	for _, w in list do
		taken[string.lower(git.normalize(w.path))] = true
	end
	return taken
end

return git

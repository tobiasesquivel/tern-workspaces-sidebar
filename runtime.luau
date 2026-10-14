--!strict
-- Bridge between the rail and the agent runtime daemon (Node).
--
-- The rail never draws the native agent list directly. Every read tick publishes its
-- one `agents:list` answer as an observation file for the daemon to arbitrate, then
-- folds the daemon's snapshot — the single arbitrated state — into the model. The
-- observation is this VM's own file (`observation-<generation>.json`, this VM the only
-- writer); the snapshot (`snapshot.json`) is the daemon's, this file only reads it.
--
-- Freshness without a stat API: the snapshot carries its own heartbeat — the triple
-- (`generation`, `seq`, `snapshot_at`), any of which moving means live (`snapshot_at`
-- is the daemon's write clock, rewritten on every write even when nothing changed).
-- No advance for 15 s is stale (the daemon may be down: `ensure` retries, bounded to
-- one spawn per 20 s cooldown); no advance for 90 s after a live one is dead (clear).
export type SnapshotRead = {
	generation: string?,
	seq: number?,
	--- Daemon write clock (ms epoch): the heartbeat that advances on every
	--- snapshot write even when nothing changed. `seq` is a pure state revision
	--- and must not bump spuriously, so liveness is the triple
	--- `(generation, seq, snapshot_at)` — any of the three moving means live.
	snapshot_at: number?,
	--- Final states by pane id, as the model folds them. `id` is the occupant
	--- identity (`terminal_id`); `completion` is the daemon's `completion_seq`.
	states: { [number]: { status: string, failed: boolean, done: boolean, id: string?, completion: number? } },
}

local runtime = {}

local OBS_PREFIX = "observation-"
local OBS_SUFFIX = ".json"
local SNAPSHOT_FILE = "snapshot.json"
--- The snapshot is a few agent records; anything bigger is not ours to parse.
local MAX_SNAPSHOT_BYTES = 65536
--- Unchanged observations are rewritten at most this often, so a live rail keeps a
--- heartbeat without rewriting the file every 250 ms tick.
local OBS_HEARTBEAT_MS = 5000
--- No snapshot advance for this long: the daemon may be down, retry `ensure`.
local STALE_MS = 15000
--- No snapshot advance for this long after a live one: stop painting the cache.
local DEAD_MS = 90000
--- One `ensure` spawn per window at most this often, however stale the snapshot.
local ENSURE_COOLDOWN_MS = 20000
local ENSURE_TIMEOUT_MS = 15000

--- The VM's own identity: a fresh generation per load, so a reload's `seq = 1` never
--- reads as older than the previous VM's writes.
local generation: string? = nil
local obs_seq = 0
local last_obs_key: string? = nil
local last_obs_ms = 0
local ensure_inflight = false
--- The last observation written, for `chime` to rewrite at once, and the last chime handed
--- to the daemon, which every later observation carries until the next one.
local last_obs: { [string]: any }? = nil
local chime_seq = 0
local last_chime: { seq: number, kind: string, at: number }? = nil
local last_ensure_ms = -ENSURE_COOLDOWN_MS
local snap_ok = false
local snap_seen_id: string? = nil
local snap_advance_ms: number? = nil

--- Pane ids are per client in Tern: this window's plugin API names a pane created by
--- anything but this window differently from the CLI (`tern ls`, the `TERN_PANE` a
--- connector reports with), which is the id the daemon keys by. Measured in the lab: a
--- `tern new tab` pane is 362606908932098 to the CLI and 10763188043778 here.
--- `cx.session:resolve("<cli id>")` answers this window's id, so the bridge learns each
--- daemon pane the snapshot lists, maps it once, and translates both ways: what it
--- publishes goes out in the daemon's ids, what it reads comes in as this window's. A
--- pane that resolves to nothing (another window's, or a VM with no `resolve`) keeps
--- its id: one id space, as in the suites, needs no translation.
local d2w: { [number]: number } = {}
local w2d: { [number]: number } = {}
--- Daemon pane id -> daemon tab id, from the snapshot.
local d_tab: { [number]: number } = {}
--- The daemon pane ids the last snapshot listed, in its order.
local known: { number } = {}
--- When a daemon pane last failed to resolve: retried after MISS_RETRY_MS.
local missed: { [number]: number } = {}
--- Resolves per tick at most (each ~7 us measured), so a window with many panes maps
--- them over a few ticks instead of in one.
local RESOLVE_PER_TICK = 32
local MISS_RETRY_MS = 10000

local function now_ms(): number
	local ok, t = pcall(tern.now)
	if ok and type(t) == "number" then
		return t
	end
	return 0
end

--- An id as the CLI spells it: `tostring` may switch to an exponent for big numbers.
local function id_text(id: number): string
	return string.format("%.0f", id)
end

--- Maps one daemon pane to this window's id through `cx.session:resolve`; nil (and a
--- miss to retry later) when it names no pane here.
local function resolve_one(cx: any, d: number): number?
	local ok, w = pcall(function()
		return cx.session:resolve(id_text(d))
	end)
	if ok and type(w) == "number" then
		d2w[d] = w
		w2d[w] = d
		missed[d] = nil
		return w
	end
	missed[d] = now_ms()
	return nil
end

--- Resolves the daemon panes the last snapshot listed that are not mapped yet, at most
--- RESOLVE_PER_TICK of them. Call once per read tick, before `publish`.
function runtime.sync_ids(cx: any)
	if cx == nil then
		return
	end
	local budget = RESOLVE_PER_TICK
	local now = now_ms()
	for _, d in known do
		if budget <= 0 then
			break
		end
		local miss = missed[d]
		if d2w[d] == nil and (miss == nil or now - miss > MISS_RETRY_MS) then
			budget -= 1
			resolve_one(cx, d)
		end
	end
end

--- This window's pane id as the daemon names it.
local function to_daemon(w: number?): number?
	if w == nil then
		return nil
	end
	return w2d[w] or w
end

--- This VM's observation identity, stable for the VM's life.
function runtime.generation(): string
	if generation == nil then
		local t = math.floor(now_ms())
		local r = 0
		pcall(function()
			r = math.random(0, 0xFFFFFF)
		end)
		generation = string.format("vm-%x-%x", t % 0x1000000, r)
	end
	return generation :: string
end

--- The shared dir: outside every watched tree, scoped per config. A `plugin-data`
--- subdir reloads the whole VM on each write, wiping caches, chimes and the runner —
--- so the bridge lives under the OS-local app data, filed by a hash both sides
--- compute from the same scope string. Resolution: `TERN_AGENT_RUNTIME_DIR` first
--- (labs pin through it), then the external scoped dir; the CLI `--data-dir`
--- overrides that on its side.

local function getenv_nonempty(name: string): string?
	local ok, v = pcall(tern.getenv, name)
	if ok and type(v) == "string" and v ~= "" then
		return v
	end
	return nil
end

--- djb2 over the scope's UTF-8 bytes, `h = (h * 33 + c) % 2^32` per step, hex 8
--- lowercase of the final value — byte for byte what the Node store does over
--- `Buffer.from(scope, "utf8")` (checked on a path with accents and kanji: both 5ddef238).
local function djb2hex(s: string): string
	local h = 5381
	for i = 1, #s do
		h = (h * 33 + string.byte(s, i)) % 4294967296
	end
	return string.format("%08x", h)
end

--- The scope both sides hash: `<plugin-data>/workspaces-sidebar` — the config's
--- plugin data dir for this plugin — `\` unified to `/`, lowercased on win32 only.
--- Never the config dir alone, never with `agent-runtime` appended.
local function scope_key(): string
	local s = string.gsub(tern.plugin.data, "\\", "/")
	s = string.gsub(s, "/+$", "")
	local ok, os_name = pcall(function()
		return tern.runtime.os
	end)
	if ok and os_name == "windows" then
		s = string.lower(s)
	end
	return s
end

--- The OS-local data root, same rule as the Node store: win32 `%LOCALAPPDATA%`,
--- darwin `~/Library/Application Support`, linux `$XDG_DATA_HOME` or
--- `~/.local/share`. No fallback under watched trees: these roots are guaranteed
--- on a normal machine, and erroring beats silently re-entering a tree that
--- reloads the VM on every write.
local function local_data_root(): string?
	local ok_os, os_name = pcall(function()
		return tern.runtime.os
	end)
	local osn: string? = if ok_os and type(os_name) == "string" then os_name else nil
	local root: string? = nil
	if osn == "macos" then
		local home = getenv_nonempty("HOME")
		if home then
			root = home .. "/Library/Application Support"
		end
	elseif osn == "windows" or osn == nil then
		root = getenv_nonempty("LOCALAPPDATA")
	else
		root = getenv_nonempty("XDG_DATA_HOME")
		if not root then
			local home = getenv_nonempty("HOME")
			if home then
				root = home .. "/.local/share"
			end
		end
	end
	if root then
		root = string.gsub(root, "\\", "/")
		root = string.gsub(root, "/+$", "")
	end
	return root
end

--- The shared dir. External, per-config, deterministic on both sides of the bridge:
--- `<local-data-root>/tern-agent-runtime/<scope-hex>` (two segments, exactly what
--- the Node store resolves). `TERN_AGENT_RUNTIME_DIR` pins through it for labs;
--- the CLI `--data-dir` overrides on its side.
function runtime.data_dir(): string
	local over = getenv_nonempty("TERN_AGENT_RUNTIME_DIR")
	if over then
		return over
	end
	local base = local_data_root()
	if base then
		return base .. "/tern-agent-runtime/" .. djb2hex(scope_key())
	end
	error("runtime.data_dir: no local data root (LOCALAPPDATA/HOME/XDG_DATA_HOME all unset)")
end

local function obs_path(): string
	return runtime.data_dir() .. "/" .. OBS_PREFIX .. runtime.generation() .. OBS_SUFFIX
end

local function snapshot_path(): string
	return runtime.data_dir() .. "/" .. SNAPSHOT_FILE
end

--- Publishes one native poll for the daemon: the agents (nil when that read failed),
--- the panes enriched with their tab and session, and the focus the daemon marks seen
--- by. File writes only, never a spawn; true when a write actually happened. Writes
--- only on change or heartbeat, so a steady rail does not churn the file per tick:
--- the change key covers agents, panes and focus only — `seq` and `observed_at`
--- move on every write by design and are never part of it.
function runtime.publish(
	native_agents: { any }?,
	panes: { any },
	tabs: { any }?,
	focused_pane: number?,
	focused_tab: number?
): boolean
	pcall(tern.fs.mkdir, runtime.data_dir())
	local tab_session: { [number]: number } = {}
	if type(tabs) == "table" then
		for _, t in tabs do
			if type(t) == "table" and type(t.id) == "number" and type(t.session) == "number" then
				tab_session[t.id] = t.session
			end
		end
	end
	local enriched: { any } = {}
	if type(panes) == "table" then
		for _, p in panes do
			if type(p) == "table" and type(p.pane) == "number" then
				local last_status: number? = nil
				if type(p.last) == "table" and type(p.last.status) == "number" then
					last_status = p.last.status
				end
				local tab: number? = if type(p.tab) == "number" then p.tab else nil
				-- A mapped pane goes out by the daemon's ids, its tab too; its session
				-- is left out, since this window's session id need not be the daemon's.
				local d = w2d[p.pane]
				table.insert(enriched, {
					pane = if d ~= nil then d else p.pane,
					tab = if d ~= nil then d_tab[d] else tab,
					session = if d == nil and tab ~= nil then tab_session[tab] else nil,
					cwd = p.cwd,
					program = p.program,
					title = p.title,
					busy = p.busy,
					kind = p.kind,
					alert = p.alert,
					last_status = last_status,
				})
			end
		end
		if #enriched == 0 then
			enriched = tern.json.array()
		end
	else
		enriched = tern.json.array()
	end
	-- A failed native read is an explicit null, which the daemon retains against;
	-- an empty list is a valid empty, which clears the natives it no longer sees.
	-- Otherwise each native block is annotated with its explicit kind: Tern's
	-- `agents:list` only reports omp today, so `agent = "omp"` is truthful — never
	-- a guess the daemon could mistake for a generic shell. A block that already
	-- names a known kind (`omp`, `claude`, `codex`, case-insensitive on `command`)
	-- keeps it; anything else stays `omp`, the only kind this list can hold.
	local agents_out: any = if native_agents == nil then tern.json.null
		elseif #native_agents == 0 then tern.json.array()
		else (function()
			local annotated: { any } = {}
			for _, a in native_agents do
				if type(a) == "table" then
					local kind: string? = if type(a.agent) == "string" then a.agent else nil
					if kind == nil and type(a.command) == "string" then
						local cmd = string.lower(a.command)
						if string.find(cmd, "claude", 1, true) then
							kind = "claude"
						elseif string.find(cmd, "codex", 1, true) then
							kind = "codex"
						end
					end
					if kind ~= "claude" and kind ~= "codex" then
						kind = "omp"
					end
					local copy: { [string]: any } = {}
					for k, v in a do
						copy[k] = v
					end
					copy.agent = kind
					if type(copy.pane) == "number" then
						copy.pane = to_daemon(copy.pane)
					end
					table.insert(annotated, copy)
				end
			end
			if #annotated == 0 then
				return tern.json.array()
			end
			return annotated
		end)()
	-- Focus in the daemon's ids: the focused pane, and its tab when the pane is mapped
	-- (else this window's tab, which names no daemon tab and so marks nothing seen).
	local focused_d = w2d[focused_pane or -1]
	if focused_d ~= nil then
		focused_pane = focused_d
		focused_tab = d_tab[focused_d] or focused_tab
	end
	local now = now_ms()
	-- The rail's sound switch: the daemon plays the chimes and mutes on `false`.
	local ok_kv, sound_kv = pcall(tern.kv.get, "sound_enabled")
	local sound_on = not (ok_kv and sound_kv == false)
	local ok_key, key = pcall(tern.json.encode, {
		agents = agents_out,
		panes = enriched,
		focused_pane = focused_pane,
		focused_tab = focused_tab,
		sound = sound_on,
	})
	if ok_key and key == last_obs_key and (now - last_obs_ms) < OBS_HEARTBEAT_MS then
		return false
	end
	obs_seq += 1
	local obs = {
		v = 1,
		observed_at = math.floor(now),
		generation = runtime.generation(),
		seq = obs_seq,
		focused_pane = focused_pane,
		focused_tab = focused_tab,
		agents = agents_out,
		panes = enriched,
		sound = sound_on,
		chime = last_chime,
	}
	local ok_enc, text = pcall(tern.json.encode, obs)
	if not ok_enc or type(text) ~= "string" then
		obs_seq -= 1
		return false
	end
	local ok_write = pcall(tern.fs.write, obs_path(), text)
	if not ok_write then
		obs_seq -= 1
		return false
	end
	if ok_key then
		last_obs_key = key
	end
	last_obs_ms = now
	last_obs = obs
	return true
end

--- Hands one chime to the daemon. Rewrites this VM's observation at once with the chime
--- in it — a file write, never a spawn. A live daemon does not play it: its own notifier
--- (`runtime/notify.mjs`) already chimes every transition it arbitrates, with herdr's 1 s
--- delay, so the handoff only keeps the rail from starting a player of its own. False —
--- the caller plays it itself — when there is no live daemon to take it: nothing
--- published yet, or a snapshot that stopped advancing.
function runtime.chime(kind: string): boolean
	local obs = last_obs
	if obs == nil or not snap_ok or runtime.is_stale() then
		return false
	end
	local now = math.floor(now_ms())
	local chime = { seq = chime_seq + 1, kind = kind, at = now }
	-- Built on a copy: a chime that never reached the file is the caller's to play, so
	-- no later observation may carry it to the daemon as well.
	local next_obs: { [string]: any } = {}
	for k, v in obs do
		next_obs[k] = v
	end
	next_obs.seq = obs_seq + 1
	next_obs.observed_at = now
	next_obs.chime = chime
	local ok_enc, text = pcall(tern.json.encode, next_obs)
	if not ok_enc or type(text) ~= "string" then
		return false
	end
	local ok_write = pcall(tern.fs.write, obs_path(), text)
	if not ok_write then
		return false
	end
	chime_seq += 1
	obs_seq += 1
	last_chime = chime
	last_obs = next_obs
	last_obs_ms = now
	return true
end

--- Reads the daemon's snapshot once. Nil is a read that failed — the caller retains
--- its cache — while a valid read, even an empty one, replaces it. Records the
--- advance (any of `generation`/`seq`/`snapshot_at` moving) the freshness rules run
--- on. Authoritative fields only: `pane_id`, `agent_status`, `failed`,
--- `completion_seq`, `terminal_id`. `done` derives from the `done` status — the
--- daemon's explicit completion. States come keyed by this window's pane ids: with a
--- `cx`, an agent pane not mapped yet is resolved on the spot (agents are few).
function runtime.read_snapshot(cx: any?): SnapshotRead?
	local ok_read, text = pcall(tern.fs.read, snapshot_path(), MAX_SNAPSHOT_BYTES)
	if not ok_read or type(text) ~= "string" then
		snap_ok = false
		return nil
	end
	local ok_dec, dec = pcall(tern.json.decode, text)
	if not ok_dec or type(dec) ~= "table" or dec.v ~= 1 or type(dec.agents) ~= "table" then
		snap_ok = false
		return nil
	end
	-- The daemon's pane index: what `sync_ids` maps next, and each pane's tab. A pane
	-- the index no longer lists is forgotten, its mapping with it.
	if type(dec.panes) == "table" then
		local listed: { [number]: boolean } = {}
		local order: { number } = {}
		for _, p in dec.panes do
			if type(p) == "table" and type(p.pane_id) == "number" then
				listed[p.pane_id] = true
				table.insert(order, p.pane_id)
				if type(p.tab_id) == "number" then
					d_tab[p.pane_id] = p.tab_id
				end
			end
		end
		for d, w in d2w do
			if not listed[d] then
				d2w[d] = nil
				if w2d[w] == d then
					w2d[w] = nil
				end
				d_tab[d] = nil
			end
		end
		known = order
	end
	local states: { [number]: { status: string, failed: boolean, done: boolean, id: string?, completion: number? } } = {}
	for _, a in dec.agents do
		if type(a) == "table" and type(a.pane_id) == "number" and type(a.agent_status) == "string" then
			local st: string = a.agent_status
			local d: number = a.pane_id
			if type(a.tab_id) == "number" and d_tab[d] == nil then
				d_tab[d] = a.tab_id
			end
			local w = d2w[d]
			if w == nil and cx ~= nil then
				local miss = missed[d]
				if miss == nil or now_ms() - miss > MISS_RETRY_MS then
					w = resolve_one(cx, d)
				end
			end
			states[if w ~= nil then w else d] = {
				status = st,
				failed = a.failed == true,
				done = st == "done",
				id = if type(a.terminal_id) == "string" then a.terminal_id else nil,
				completion = if type(a.completion_seq) == "number" then a.completion_seq else nil,
			}
		end
	end
	snap_ok = true
	local gen: string? = if type(dec.generation) == "string" then dec.generation else nil
	local seq: number? = if type(dec.seq) == "number" then dec.seq else nil
	local written: number? = if type(dec.snapshot_at) == "number" then dec.snapshot_at else nil
	local id = (gen or "?") .. ":" .. tostring(seq) .. ":" .. tostring(written)
	if snap_seen_id == nil or id ~= snap_seen_id then
		snap_seen_id = id
		snap_advance_ms = now_ms()
	end
	return { generation = gen, seq = seq, snapshot_at = written, states = states }
end

--- No snapshot advance for long enough that the daemon may be down. True before the
-- first good read too, which is what starts the daemon on a fresh window.
function runtime.is_stale(): boolean
	if snap_advance_ms == nil then
		return not snap_ok
	end
	return (now_ms() - (snap_advance_ms :: number)) > STALE_MS
end

--- A live snapshot gone quiet for long enough that the cache must clear instead of
-- faking a live rail. False before any snapshot ever advanced: nothing is painted yet.
function runtime.is_dead(): boolean
	if snap_advance_ms == nil then
		return false
	end
	return (now_ms() - (snap_advance_ms :: number)) > DEAD_MS
end

function runtime.should_ensure(): boolean
	if not snap_ok then
		return true
	end
	return runtime.is_stale()
end

--- Starts the daemon (`node runtime/cli.mjs ensure --data-dir <dir>`) at most once
-- per cooldown, never twice inflight. True only when it really spawned, so the read
-- tick can spend the hook's one spawn on it the way `sound.flush` reports its own.
function runtime.ensure(): boolean
	if ensure_inflight then
		return false
	end
	if not runtime.should_ensure() then
		return false
	end
	local now = now_ms()
	if (now - last_ensure_ms) < ENSURE_COOLDOWN_MS then
		return false
	end
	local argv = { "node", tern.plugin.dir .. "/runtime/cli.mjs", "ensure", "--data-dir", runtime.data_dir() }
	last_ensure_ms = now
	ensure_inflight = true
	local ok = pcall(tern.process.run, argv, { timeout_ms = ENSURE_TIMEOUT_MS }, function()
		ensure_inflight = false
	end)
	if not ok then
		ensure_inflight = false
		return false
	end
	return true
end

--- Snapshot and daemon state for the tick and the suites: no I/O, never raises.
function runtime.info(): { generation: string, obs_seq: number, inflight: boolean, ok: boolean, stale: boolean, dead: boolean }
	return {
		generation = runtime.generation(),
		obs_seq = obs_seq,
		inflight = ensure_inflight,
		ok = snap_ok,
		stale = runtime.is_stale(),
		dead = runtime.is_dead(),
	}
end

return runtime

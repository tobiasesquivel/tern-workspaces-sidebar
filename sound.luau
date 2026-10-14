--!strict
-- Notification chimes for agent state changes: herdr's rule, ported
-- (`src/app/actions.rs`, `notification_sound_for_state_change`).
--
-- Two sounds, one per edge: an agent that finished its turn in a tab you are not looking at
-- (`done`), and an agent that stopped to ask you something (`request`). Nothing else chimes
-- — not a first sighting, not a repeat, not an exit.
--
-- The chime is split across the two poll ticks, because the budget is per hook. The read
-- tick calls `observe` with the moves its agent poll (`model.poll_agents`) produced and then
-- `flush` in the same invocation: observing reads no file and spawns nothing, the player
-- starts in `flush` — the tick that is allowed I/O. A paint never does either: it draws the
-- state the poll cached, so the `?` on the rail is a question this tick already played.
-- `flush` returns whether it really started the player, which is how the tick knows it has
-- spent the hook's one spawn and must leave its git read for the next one.
--
-- Deviation from herdr: herdr suppresses the `done` sound only while the outer terminal has
-- focus (`active_tab_suppresses_notifications`), so a focused tab inside a background
-- window stays silent too. Tern exposes no window blur/visibility event, so the focused tab
-- is the whole rule here: an agent in the tab you are on never chimes `done`, even with Tern
-- behind another window. `request` is not suppressed on either side (herdr does not gate
-- it), which is why a question is the one thing that can interrupt the tab you are on.

export type Kind = "done" | "request"

--- One queued chime: the pane whose agent moved, and what it earned.
export type Chime = { pane: number, kind: Kind }

--- One agent that moved between two polls, as the model hands it over (`AgentMove`): its
--- pane, the state it was in (nil on a first sighting), the state it is in now, whether
--- its pane sits in the tab you are on — herdr's suppress-active rule needs that fact —
--- and whether the daemon flagged this move an explicit completion (`done` rides an
--- `idle` arrival the poll never saw as a native transition).
export type Move = { pane: number, prev: string?, next: string, active: boolean, done: boolean? }

--- The bound herdr puts on a player (15 s): long enough for either mp3, short enough that a
--- wedged player cannot pile up behind the next one.
local PLAY_MS = 15000

local sound = {}

--- The chimes nothing has played yet. `observe` appends, the read tick drains. No state
--- history lives here: the per-pane state is the model's single observation.
local queued: { Chime } = {}

--- Who plays a chime instead of this VM, when someone can: the runtime daemon. A spawn
--- from a window hook is synchronous and spikes past the 50 ms budget at random
--- (measured: 30 to 77 ms for any program on a loaded Windows machine), and one past it
--- disables every timer of the plugin — the rail froze on the very tick that played the
--- question. The daemon is a long-lived process outside the window: the rail hands it the
--- chime and the daemon starts the same player. nil, or a handoff that answers false (no
--- live daemon), and this VM starts the player itself, as before.
local handoff: ((kind: Kind) -> boolean)? = nil

function sound.set_handoff(fn: ((kind: Kind) -> boolean)?)
	handoff = fn
end

--- Absolute path of the audio file for a kind, inside the plugin folder.
---
--- Lazy, not a constant: the plugin directory is not known until `tern` is, and this file is
--- also loaded by the module suites against a fake tern. Forward slashes on every platform,
--- the way this repo spells paths and the way the argv in `flush` is pinned: the machine's
--- file APIs take them (measured: wscript resolves a script path spelled with `/`), so a
--- chime never needs a separator branch.
function sound.path(kind: Kind): string
	return tern.plugin.dir .. "/sounds/" .. kind .. ".mp3"
end

--- The player for a platform, or nil where there is none. herdr ships a Windows and a macOS
--- player; the Linux one (a probed list of audio players) is deliberately not ported, so
--- Linux stays silent and the README says so.
local function player_argv(file: string): { string }?
	local os_name = tern.runtime.os
	if os_name == "windows" then
		-- wscript.exe is a GUI-subsystem host, so the PowerShell it starts hidden never
		-- flashes a console: `play.vbs` is the launcher and `play.ps1` the player.
		local dir = tern.plugin.dir
		return { "wscript.exe", "//Nologo", dir .. "/scripts/play.vbs", file, dir .. "/scripts/play.ps1" }
	elseif os_name == "macos" then
		return { "afplay", file }
	end
	return nil
end

--- herdr's `notification_sound_for_state_change` as a pure function: the chime a pane's
--- agent transition deserves, or nil. `done` marks the move a completion of the
--- daemon's `done` status: an `idle` arrival with it chimes `done` even when the
--- poll never saw the `working` before it (the snapshot folded a turn the native
--- list skipped). `unknown` is never a busy state and chimes nothing.
---
--- `prev == nil` is a first sighting — the rail has just started and nothing was observed to
--- move — and never chimes. `active` says the pane sits in the focused tab, which is herdr's
--- `suppress_active_tab_notifications`.
function sound.kind_for(prev: string?, next: string, active: boolean, done: boolean?): Kind?
	-- The completion edge first: the model emits `done` exactly once per completion,
	-- even when the `idle` arrival matches what the pane already showed. A first
	-- sighting stays silent (a reload hears nothing).
	if next == "idle" and done == true and prev ~= nil and not active then
		return "done"
	end
	if prev == nil or next == prev then
		return nil
	end
	if next == "waiting_input" then
		-- A question is worth hearing wherever you are: herdr does not gate this one.
		return "request"
	end
	if next == "unknown" then
		return nil
	end
	if next == "idle" and (prev == "working" or prev == "waiting_input") and not active then
		return "done"
	end
	return nil
end

--- Queues the chimes the moves it is handed deserve, and returns them.
---
--- The moves come from the one per-pane state the rail keeps (`model.poll_agents`), so the
--- `?` badge you see and the chime you hear are the same fact: nothing is diffed or
--- remembered here. The read tick calls this with the moves its poll just produced, then
--- flushes in the same invocation — so no chime waits for a paint, and none is lost when no
--- rail is mounted to repaint.
function sound.observe(moves: { Move }): { Chime }
	local out: { Chime } = {}
	for _, move in moves do
		local kind = sound.kind_for(move.prev, move.next, move.active, move.done)
		if kind ~= nil then
			local chime = { pane = move.pane, kind = kind }
			table.insert(out, chime)
			table.insert(queued, chime)
		end
	end
	return out
end

--- Plays at most one queued chime and drops the rest: hands it to the daemon when one
--- takes it, else starts the player — the only place in the plugin where a sound may
--- start a process.
---
--- Returns true only when it really started the player, so the caller can spend the hook's
--- budget on it: the read tick takes the player as its one spawn and leaves the git read for
--- the next tick. False for a queue with nothing to play, a mute, an unsupported platform, a
--- missing mp3 and a spawn that raised — nothing was started, so nothing was spent.
function sound.flush(): boolean
	-- The queue is drained whatever happens below. A chime is about a moment that has
	-- passed: three agents finishing together is one sound, not three overlapping players,
	-- and a muted chime is not owed to you later.
	local pending = queued
	queued = {}
	if #pending == 0 then
		return false
	end
	if tern.kv.get("sound_enabled") == false then
		return false
	end
	-- One sound per tick, and a question outranks a completion: when two chimes wait for
	-- the same tick, hearing the request is what matters — a waiter you did not answer is
	-- worse than a finished turn you did not hear.
	local chime = pending[1]
	for _, c in pending do
		if c.kind == "request" then
			chime = c
			break
		end
	end
	-- Handed off: the daemon plays it and this hook spawned nothing, so nothing is spent.
	if handoff ~= nil then
		local ok_hand, handed = pcall(handoff, chime.kind)
		if ok_hand and handed == true then
			return false
		end
	end
	local file = sound.path(chime.kind)
	local ok_exists, exists = pcall(tern.fs.exists, file)
	if not ok_exists or exists ~= true then
		-- A deleted or renamed mp3 is a mute, not an error: this repo logs nothing.
		return false
	end
	local argv = player_argv(file)
	if argv == nil then
		return false
	end
	-- A spawn failure raises (iOS has no child processes, and a missing player is a spawn
	-- failure), so the one call that can raise is the one that is guarded: a chime that
	-- cannot start must leave the tick whole. The callback ignores the result — whether a
	-- sound played is nothing to act on. What the caller acts on is whether the spawn
	-- started at all: the read tick spends its one spawn there and defers its git read.
	return pcall(function()
		tern.process.run(argv, { timeout_ms = PLAY_MS }, function() end)
	end)
end

return sound

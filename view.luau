--!strict
-- Canvas tree builder + change fingerprint (what triggers a redraw).

local format = require("./format")
local group = require("./group")
local model = require("./model")
local layout_mod = require("./layout")
local worktrees = require("./worktrees")

local view_mod = {}

local TAB_COLORS: { TabColor } = {
	"blue", "green", "yellow", "orange", "red", "purple", "teal", "pink"
}

local COLOR_LABELS: { [string]: { glyph: string, tone: string } } = {
	blue = { glyph = "🔵", tone = "accent" },
	green = { glyph = "🟢", tone = "accent" },
	yellow = { glyph = "🟡", tone = "warn" },
	orange = { glyph = "🟠", tone = "warn" },
	red = { glyph = "🔴", tone = "error" },
	purple = { glyph = "🟣", tone = "accent" },
	teal = { glyph = "🩵", tone = "accent" },
	pink = { glyph = "🩷", tone = "muted" },
}

-- Color del tag de un tab -> token de span para su punto (sin emoji).
local COLOR_TOKEN: { [string]: string } = {
	blue = "accent", green = "success", yellow = "warning", orange = "warning",
	red = "error", purple = "accent", teal = "info", pink = "muted",
}

-- El click derecho no existe en las vistas de plugin de Tern: el menú de una fila
-- se abre con este botón, o con doble click en cualquier parte de la fila.
local function more_icon(kind: string, id: number): Node
	return tern.ui.node("icon", {
		key = "more_" .. kind .. "_" .. id,
		name = "more",
		role = "ws-more",
		actions = { click = "menu_" .. kind .. ":" .. id },
	})
end

local function row_node(cells: { Node }, role: string, click: string, dblclick: string): Node
	local row = tern.ui.row(cells)
	local p: { [string]: any } = row.p or {}
	p.role = role
	p.actions = { click = click, dblclick = dblclick }
	row.p = p
	return row
end

function view_mod.next_tab_color(cur: TabColor?): TabColor?
	if not cur then
		return "blue"
	end
	for i, c in TAB_COLORS do
		if c == cur then
			if i < #TAB_COLORS then
				return TAB_COLORS[i + 1]
			else
				return nil
			end
		end
	end
	return "blue"
end

function view_mod.fingerprint(snap: model.Snapshot): string
	local parts = {}
	local style = tern.kv.get("path_style") or "smart"
	table.insert(parts, "style:" .. style)
	table.insert(parts, "tags:" .. (if tern.kv.get("color_tags_enabled") == false then "0" else "1"))
	table.insert(parts, "labels:" .. (if tern.kv.get("color_labels_enabled") == false then "0" else "1"))
	table.insert(parts, "focus:" .. (snap.focused_tab or 0))
	table.insert(parts, "ntabs:" .. #snap.tabs)
	-- Bumped when a cached git answer changes, so the rail repaints once it lands.
	table.insert(parts, "wt:" .. worktrees.generation())
	table.insert(parts, "moving:" .. (tern.kv.get("moving_tab") or 0))
	table.insert(parts, "filter:" .. (tern.kv.get("tab_filter") or "all"))

	for _, s in snap.sessions do
		local folded = snap.folded[s.id] == true
		table.insert(parts, s.id .. ":" .. (if s.current then "1" else "0") .. ":" .. (if s.locked then "L" else "U") .. ":" .. (if folded then "C" else "E") .. ":" .. s.name .. ":" .. s.tabs)
		-- Ahead/behind (the exact strings the cell draws): empty when nothing shows,
		-- "-" while git has not answered yet.
		local head = snap.head[s.id]
		local c = if head then format.counters(head.ahead, head.behind, head.upstream ~= nil) else nil
		table.insert(parts, "ab" .. s.id .. ":" .. (if c then c.up .. c.down else "-"))
	end
	-- Nesting: a row changing depth, gaining or losing children repaints even when the
	-- session list itself is untouched.
	for _, row in snap.rows do
		table.insert(parts, "r" .. row.id .. ":" .. row.depth .. ":" .. row.children)
	end
	for _, t in snap.tabs do
		local tf = snap.flags[t.id]
		local flag_str = ""
		if tf then
			flag_str = (if tf.busy then "B" else "") .. (if tf.waiting then "W" else "")
			flag_str ..= (if tf.alert then "A" else "") .. (if tf.done then "D" else "")
		end
		local col = t.color or tern.kv.get("tab_color_" .. t.id) or ""
		table.insert(parts, "t" .. t.id .. ":" .. col .. ":" .. flag_str .. ":" .. (t.name or t.title or t.cwd or ""))
	end
	return table.concat(parts, "|")
end

function view_mod.build(snap: model.Snapshot): Node
	local items: { Node } = {}
	local by_id: { [number]: ManagedSession } = {}
	for _, s in snap.sessions do
		by_id[s.id] = s
	end
	local in_move_mode = (tern.kv.get("moving_tab") ~= nil)
	local moving_tab = tern.kv.get("moving_tab")

	-- Una fila anidada bajo un grupo plegado no se dibuja. El filtro va acá, y no con
	-- un `continue`, para que el orden del rail siga siendo el de `model.rail_rows`.
	local collapsed = snap.folded
	local visible: { group.Row } = {}
	for _, row in snap.rows do
		local parent = row.parent
		local hidden = parent ~= nil and collapsed[parent] == true
		if not hidden then
			table.insert(visible, row)
		end
	end

	for _, row in visible do
		-- La sesión pudo cerrarse entre el armado de las filas y este dibujo.
		local s = by_id[row.id]
		if not s then
			continue
		end
		-- El pliegue de la fila: elige el chevron y esconde sus tabs.
		local folded = collapsed[s.id] == true

		local session_tabs = snap.tabs_of[s.id] or {}
		local ws_busy = 0
		local ws_waiting = 0
		local ws_done = 0
		for _, t in session_tabs do
			local f = snap.flags[t.id]
			if f then
				if f.busy then ws_busy += 1 end
				if f.waiting then ws_waiting += 1 end
				if f.done then ws_done += 1 end
			end
		end

		-- Fila de workspace: chevron + carpeta nativos de Tern, nombre y contador de tabs.
		-- El click pliega la fila (no cambia de sesión): para entrar a un workspace se
		-- clickea una de sus tabs, y "Open workspace" queda en el menú.
		local header_cells: { Node } = {
			tern.ui.node("icon", { name = if folded then "chev-r" else "chev", tone = "muted", role = "ws-chev" }),
			tern.ui.node("icon", {
				name = if folded then "folder" else "folder-open",
				tone = if s.current then "accent" else "muted",
				role = "ws-icon",
			}),
			tern.ui.text({
				tern.ui.span(s.name, if s.current then "strong" else ""),
				tern.ui.span("  " .. tostring(#session_tabs), "dim"),
			}),
		}

		-- Sangría de un checkout anidado: celda real (el ancho lo pone el CSS), así la
		-- fila conserva ws-space / ws-space-current y con eso su resaltado.
		if row.depth > 0 then
			table.insert(header_cells, 1, tern.ui.node("text", {
				key = "ws_indent_" .. s.id,
				role = "ws-indent",
				text = " ",
			}))
		end

		-- Worktree checkout: la rama al lado del nombre, en su propia celda para
		-- que se achique sola cuando el rail es angosto (el nombre manda).
		-- `tern.ui.text` recibe la lista de spans, así que los props van en node.p
		-- junto al role: una key dentro de esa lista la ignora el runtime.
		local wt = snap.wt[s.id]
		if wt and wt.branch and wt.branch ~= s.name then
			local cell = tern.ui.text({ tern.ui.span(wt.branch, "dim") })
			local cp: { [string]: any } = cell.p or {}
			cp.key = "ws_branch_" .. s.id
			cp.role = "ws-branch"
			cell.p = cp
			table.insert(header_cells, cell)
		end

		-- Ahead/behind contra el upstream, como herdr: verde arriba, rojo abajo. Va
		-- después de la rama y se dibuja aunque la rama calle (coincide con el nombre),
		-- porque el color lo lleva cada span y no la celda.
		local head = snap.head[s.id]
		if head then
			local c = format.counters(head.ahead, head.behind, head.upstream ~= nil)
			if c.up ~= "" or c.down ~= "" then
				local cell = tern.ui.text({
					tern.ui.span(c.up, "success"),
					tern.ui.span(c.down, "error"),
				})
				local cp: { [string]: any } = cell.p or {}
				cp.key = "ws_ab_" .. s.id
				cp.role = "ws-ab"
				cell.p = cp
				table.insert(header_cells, cell)
			end
		end

		if s.locked then
			table.insert(header_cells, tern.ui.node("icon", { name = "lock", tone = "warn", role = "ws-lock" }))
		end
		if ws_waiting > 0 then
			table.insert(header_cells, tern.ui.node("badge", {
				key = "ws_wait_" .. s.id,
				text = ws_waiting .. "?",
				tone = "warn",
				role = "ws-status",
			}))
		end
		if ws_busy > 0 then
			table.insert(header_cells, tern.ui.node("badge", {
				key = "ws_busy_" .. s.id,
				text = ws_busy .. "◐",
				tone = "accent",
				role = "ws-status",
			}))
		end
		-- Los turnos que terminaron y nadie miró: ✓ celeste, no el `!` rojo (no fallaron).
		if ws_done > 0 then
			table.insert(header_cells, tern.ui.node("badge", {
				key = "ws_done_" .. s.id,
				text = ws_done .. "✓",
				tone = "info",
				role = "ws-done",
			}))
		end

		if in_move_mode then
			table.insert(header_cells, tern.ui.node("badge", {
				key = "ws_movehere_" .. s.id,
				text = "Move here",
				tone = "accent",
				role = "ws-status",
				actions = { click = "movehere:" .. s.id },
			}))
		else
			table.insert(header_cells, more_icon("ws", s.id))
		end

		table.insert(items, row_node(header_cells, if s.current then "ws-space-current" else "ws-space", "fold:" .. s.id, "menu_ws:" .. s.id))

		if not folded then
			for i, t in session_tabs do
				local branch = if i == #session_tabs then "  └─ " else "  ├─ "
				local is_active = (t.id == snap.focused_tab)
				local dot_glyph = if is_active then "● " else "○ "

				local effective_color = t.color or tern.kv.get("tab_color_" .. t.id)
				local color_info = if effective_color then COLOR_LABELS[effective_color] else nil

				local display_name = format.tab_display_name(t, snap.panes[t.pane])

				local tf = snap.flags[t.id]
				local dot_token = if color_info
					then (COLOR_TOKEN[effective_color] or "accent")
					else (if is_active then "accent" else "muted")
				local dot_glyph = if is_active or color_info then "● " else "○ "
				local tab_icon = if tf and tf.is_agent then "user" else "terminal"

				local tab_cells: { Node } = {
					tern.ui.node("icon", {
						name = tab_icon,
						tone = if is_active then "accent" else "muted",
						role = "ws-icon",
					}),
					tern.ui.text({
						tern.ui.span(branch, "dim"),
						tern.ui.span(dot_glyph, dot_token),
						tern.ui.span(display_name, if is_active then "strong" else ""),
					}),
				}

				if tf then
					if tf.waiting then
						table.insert(tab_cells, tern.ui.node("badge", {
							key = "tab_wait_" .. t.id,
							text = "?",
							tone = "warn",
							role = "ws-status",
						}))
					elseif tf.busy then
						table.insert(tab_cells, tern.ui.node("badge", {
							key = "tab_busy_" .. t.id,
							text = "◐",
							tone = "accent",
							role = "ws-status",
						}))
					elseif tf.alert then
						-- El `!` rojo va antes del ✓ a propósito: un tab con más de un agente
						-- —uno que terminó su turno y otro que falló— lleva las dos banderas, y
						-- un error no puede pasar por éxito.
						table.insert(tab_cells, tern.ui.node("badge", {
							key = "tab_alert_" .. t.id,
							text = "!",
							tone = "error",
							role = "ws-status",
						}))
					elseif tf.done then
						-- El ✓ celeste: el agente terminó su turno en una tab que no mirabas, y
						-- sigue sin verse hasta que la enfoques (ahí Tern limpia su `alert`).
						-- Glifo propio en vez del `!`: terminó bien, no falló. El color lo pone
						-- el role (`sidebar.css`, celeste propio), no el tono del tema.
						table.insert(tab_cells, tern.ui.node("badge", {
							key = "tab_done_" .. t.id,
							text = "✓",
							tone = "info",
							role = "ws-done",
						}))
					end
				end

				if in_move_mode and moving_tab == t.id then
					table.insert(tab_cells, tern.ui.node("badge", {
						key = "tab_moving_" .. t.id,
						text = "moving",
						tone = "accent",
						role = "ws-status",
					}))
				end

				table.insert(tab_cells, more_icon("tab", t.id))

				table.insert(items, row_node(tab_cells, if is_active then "ws-tab-current" else "ws-tab", "tab:" .. t.id, "menu_tab:" .. t.id))
			end
		end

		table.insert(items, tern.ui.node("text", { key = "sp_" .. s.id, text = " " }))
	end

	table.insert(items, tern.ui.rule(""))
	if in_move_mode then
		table.insert(items, tern.ui.row({
			tern.ui.node("badge", {
				key = "cancel_move_ws",
				text = "Cancel move (esc)",
				tone = "warn",
				actions = { click = "cancel_move" },
			}),
		}))
	else
		table.insert(items, tern.ui.row({
			tern.ui.node("badge", {
				key = "new_ws",
				text = "+ Workspace",
				tone = "accent",
				actions = { click = "new" },
			}),
			-- The rail carries its own off switch: the status segment and the chord are the
			-- only other ways, and neither is always on screen. The action is `hide` and not
			-- `toggle`: Tern reserves `toggle` for its own collapse handling, so a node that
			-- asks for it never reaches the plugin's canvas_action.
			tern.ui.node("badge", {
				key = "hide_ws",
				text = "Hide",
				tone = "muted",
				actions = { click = "hide" },
			}),
		}))
	end

	return tern.ui.col(items)
end

return view_mod

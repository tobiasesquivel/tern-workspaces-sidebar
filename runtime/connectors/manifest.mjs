// runtime/connectors/manifest.mjs — herdr's agent-detection manifests, interpreted.
//
// A port of herdr's manifest engine (github.com/herdrdev/herdr, Apache-2.0,
// `src/detect/manifest.rs` at commit 212b710): the `.toml` rule files, their
// regions, their matchers and their choice of rule. What it keeps from herdr:
//   - every rule is evaluated on its own region; the highest `priority` wins and
//     a tie keeps the first rule in the file;
//   - `contains` compares in lower case, `regex` runs on the whole region and
//     `line_regex` on each line; `all`/`any`/`not` nest;
//   - `osc_title` and `osc_progress` read the OSC title and progress, never the
//     screen;
//   - no rule matched is `idle` for a known agent (herdr's
//     DEFAULT_KNOWN_AGENT_IDLE_FALLBACK), never `unknown`;
//   - `skip_state_update` drops the read instead of publishing it;
//   - the manifest order: a cached remote copy (herdr's own
//     `%LOCALAPPDATA%/herdr/agent-detection/remote/<agent>.toml`, read only)
//     when it compiles and is not older than the bundled copy, else the bundled
//     copy in ./manifests (the remote 2026.10.11.1 files, verbatim).
// What it adds (research/herdr-agent-detection.md, deviations): a tern overlay,
// ./manifests/tern-<agent>.toml, whose rules are appended to herdr's — the
// Windows prompt box of Claude, Codex's first-run pickers and visible composer,
// and omp's setup wizard. herdr has no omp manifest: omp is a full-lifecycle
// agent there, and here its screen is read only while `start` waits.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = join(HERE, "manifests");
export const ENGINE_VERSION = 3;
const STATES = new Set(["idle", "working", "blocked", "unknown"]);
const RULE_KEYS = new Set([
  "id",
  "state",
  "priority",
  "region",
  "visible_idle",
  "visible_blocker",
  "visible_working",
  "skip_state_update",
  "contains",
  "regex",
  "line_regex",
  "all",
  "any",
  "not",
]);
const GATE_KEYS = new Set(["contains", "regex", "line_regex", "all", "any", "not"]);
const HEADER_KEYS = new Set(["id", "version", "min_engine_version", "updated_at", "aliases", "rules"]);

// ---------------------------------------------------------------------------
// TOML: the subset the manifests use — comments, `key = value`, `[[rules]]`,
// basic and literal strings, integers, booleans, arrays and inline tables
// (which may span lines, as herdr's files do).
// ---------------------------------------------------------------------------

export function parseToml(src) {
  let i = 0;
  const text = String(src);
  const root = {};
  let target = root;

  const fail = (msg) => {
    throw new Error(`toml: ${msg} at offset ${i}`);
  };
  const skipWs = (newlines) => {
    for (;;) {
      const ch = text[i];
      if (ch === " " || ch === "\t" || ch === "\r" || (newlines && ch === "\n")) i += 1;
      else if (ch === "#") {
        while (i < text.length && text[i] !== "\n") i += 1;
      } else return;
    }
  };
  const key = () => {
    skipWs(false);
    if (text[i] === '"' || text[i] === "'") return string();
    const start = i;
    while (i < text.length && /[A-Za-z0-9_-]/.test(text[i])) i += 1;
    if (i === start) fail("expected a key");
    return text.slice(start, i);
  };
  const string = () => {
    const quote = text[i];
    i += 1;
    let out = "";
    for (;;) {
      if (i >= text.length || text[i] === "\n") fail("unterminated string");
      const ch = text[i];
      if (ch === quote) {
        i += 1;
        return out;
      }
      if (quote === '"' && ch === "\\") {
        const e = text[i + 1];
        i += 2;
        if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "r") out += "\r";
        else if (e === '"') out += '"';
        else if (e === "\\") out += "\\";
        else if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          const hex = text.slice(i, i + len);
          if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) fail("bad unicode escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          i += len;
        } else fail(`bad escape \\${e}`);
        continue;
      }
      out += ch;
      i += 1;
    }
  };
  const value = () => {
    skipWs(false);
    const ch = text[i];
    if (ch === '"' || ch === "'") return string();
    if (ch === "[") {
      i += 1;
      const arr = [];
      for (;;) {
        skipWs(true);
        if (text[i] === "]") {
          i += 1;
          return arr;
        }
        arr.push(value());
        skipWs(true);
        if (text[i] === ",") i += 1;
        else if (text[i] !== "]") fail("expected , or ]");
      }
    }
    if (ch === "{") {
      i += 1;
      const obj = {};
      for (;;) {
        skipWs(true);
        if (text[i] === "}") {
          i += 1;
          return obj;
        }
        const k = key();
        skipWs(false);
        if (text[i] !== "=") fail("expected =");
        i += 1;
        obj[k] = value();
        skipWs(true);
        if (text[i] === ",") i += 1;
        else if (text[i] !== "}") fail("expected , or }");
      }
    }
    const m = /^(true|false|[+-]?\d+)/.exec(text.slice(i, i + 32));
    if (!m) fail("expected a value");
    i += m[0].length;
    if (m[0] === "true") return true;
    if (m[0] === "false") return false;
    return Number(m[0]);
  };

  for (;;) {
    skipWs(true);
    if (i >= text.length) break;
    if (text.startsWith("[[", i)) {
      i += 2;
      const name = key();
      skipWs(false);
      if (!text.startsWith("]]", i)) fail("expected ]]");
      i += 2;
      if (!Array.isArray(root[name])) root[name] = [];
      target = {};
      root[name].push(target);
      continue;
    }
    if (text[i] === "[") {
      i += 1;
      const name = key();
      skipWs(false);
      if (text[i] !== "]") fail("expected ]");
      i += 1;
      target = root[name] = root[name] ?? {};
      continue;
    }
    const k = key();
    skipWs(false);
    if (text[i] !== "=") fail("expected =");
    i += 1;
    target[k] = value();
    skipWs(false);
    if (i < text.length && text[i] !== "\n") fail("expected end of line");
  }
  return root;
}

// ---------------------------------------------------------------------------
// Regex: Rust `regex` syntax to a JavaScript RegExp (unicode mode).
// ---------------------------------------------------------------------------

export function translateRegex(pattern) {
  let src = String(pattern);
  const flags = new Set(["u"]);
  for (;;) {
    const m = /^\(\?([imsx]+)\)/.exec(src);
    if (!m) break;
    for (const f of m[1]) {
      if (f === "x") throw new Error("regex: (?x) is not supported");
      flags.add(f);
    }
    src = src.slice(m[0].length);
  }
  const multi = flags.has("m");
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = src[i + 1];
    if (next === "x" && src[i + 2] === "{") {
      const end = src.indexOf("}", i + 3);
      out += `\\u{${src.slice(i + 3, end)}}`;
      i = end;
      continue;
    }
    if (next === "z") {
      out += multi ? "(?![\\s\\S])" : "$";
      i += 1;
      continue;
    }
    if (next === "A") {
      out += multi ? "(?<![\\s\\S])" : "^";
      i += 1;
      continue;
    }
    out += ch + (next ?? "");
    i += 1;
  }
  return new RegExp(out, [...flags].join(""));
}

// ---------------------------------------------------------------------------
// Regions (src/detect/manifest.rs `region` and helpers). Lines follow Rust's
// `str::lines()`: no empty last line after the final newline.
// ---------------------------------------------------------------------------

function linesOf(content) {
  if (content.length === 0) return [];
  const parts = content.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function lineStart(content, lines, index) {
  let off = 0;
  for (let k = 0; k < Math.min(index, lines.length); k += 1) off += lines[k].length + 1;
  return Math.min(off, content.length);
}

function fromLine(content, lines, index) {
  return content.slice(lineStart(content, lines, index));
}

export function isHorizontalRule(line) {
  const t = line.trim();
  if (t.length === 0) return false;
  let n = 0;
  for (const ch of t) {
    if (ch === "─") n += 1;
    else break;
  }
  if (n === 0) return false;
  const suffix = t.slice(n).trimStart();
  return suffix.length === 0 || n >= 3;
}

const isCodexPrompt = (l) => l === "›" || l.startsWith("› ");
const isCodexBlock = (l) => l.startsWith("•") || l.startsWith("■") || l.startsWith("✗") || l.startsWith("✓");

function currentCodexPrompt(lines) {
  let idx = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (isCodexPrompt(lines[k])) {
      idx = k;
      break;
    }
  }
  if (idx < 0) return null;
  if (lines.slice(idx + 1).some(isCodexBlock)) return null;
  return idx;
}

function promptBoxTop(lines) {
  let count = 0;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (isHorizontalRule(lines[k])) {
      count += 1;
      if (count === 2) return k;
    }
  }
  return null;
}

function abovePromptBox(content) {
  const lines = linesOf(content);
  const top = promptBoxTop(lines);
  if (top === null) return content;
  return content.slice(0, lineStart(content, lines, top));
}

export function region(input, spec) {
  const name = String(spec ?? "whole_recent").trim();
  if (name === "osc_title") return input.title ?? "";
  if (name === "osc_progress") return input.progress ?? "";
  const content = input.screen ?? "";
  const lines = () => linesOf(content);
  switch (name) {
    case "whole_recent":
      return content;
    case "after_last_prompt_marker": {
      const ls = lines();
      let idx = -1;
      for (let k = ls.length - 1; k >= 0; k -= 1) {
        if (isCodexPrompt(ls[k])) {
          idx = k;
          break;
        }
      }
      return idx < 0 ? content : fromLine(content, ls, idx + 1);
    }
    case "before_current_prompt_marker": {
      const ls = lines();
      const idx = currentCodexPrompt(ls);
      return idx === null ? content : content.slice(0, lineStart(content, ls, idx));
    }
    case "whole_recent_without_current_prompt_marker":
      return currentCodexPrompt(lines()) === null ? content : "";
    case "current_prompt_block_marker": {
      const ls = lines();
      const idx = currentCodexPrompt(ls);
      if (idx === null) return "";
      for (let k = idx - 1; k >= 0; k -= 1) if (isCodexBlock(ls[k])) return ls[k];
      return "";
    }
    case "after_current_prompt_block_marker": {
      const ls = lines();
      const idx = currentCodexPrompt(ls);
      if (idx === null) return "";
      for (let k = idx - 1; k >= 0; k -= 1) if (isCodexBlock(ls[k])) return fromLine(content, ls, k);
      return "";
    }
    case "prompt_box_body": {
      const ls = lines();
      const top = promptBoxTop(ls);
      if (top === null) return "";
      let end = ls.length;
      for (let k = top + 1; k < ls.length; k += 1) {
        if (isHorizontalRule(ls[k])) {
          end = k;
          break;
        }
      }
      return content.slice(lineStart(content, ls, top + 1), lineStart(content, ls, end));
    }
    case "above_prompt_box":
      return abovePromptBox(content);
    case "last_non_empty_above_prompt_box": {
      const ls = linesOf(abovePromptBox(content));
      for (let k = ls.length - 1; k >= 0; k -= 1) if (ls[k].trim() !== "") return ls[k];
      return "";
    }
    case "after_last_horizontal_rule": {
      let end = 0;
      let off = 0;
      for (const line of content.split("\n")) {
        const next = off + line.length + 1;
        if (isHorizontalRule(line)) end = Math.min(next, content.length);
        off = next;
      }
      return content.slice(end);
    }
    default:
      break;
  }
  let m = /^bottom_lines\((\d+)\)$/.exec(name);
  if (m) {
    const ls = lines();
    return fromLine(content, ls, Math.max(0, ls.length - Number(m[1])));
  }
  m = /^bottom_non_empty_lines\((\d+)\)$/.exec(name);
  if (m) {
    const ls = lines();
    let start = null;
    let n = 0;
    for (let k = ls.length - 1; k >= 0 && n < Number(m[1]); k -= 1) {
      if (ls[k].trim() !== "") {
        n += 1;
        start = k;
      }
    }
    return start === null ? "" : fromLine(content, ls, start);
  }
  m = /^top_non_empty_lines\(([1-9]\d*)\)$/.exec(name);
  if (m && Number(m[1]) <= 65535) {
    const ls = lines();
    let end = null;
    let n = 0;
    for (let k = 0; k < ls.length && n < Number(m[1]); k += 1) {
      if (ls[k].trim() !== "") {
        n += 1;
        end = k;
      }
    }
    return end === null ? "" : content.slice(0, lineStart(content, ls, end + 1));
  }
  return "";
}

function validRegion(name) {
  return (
    [
      "osc_title",
      "osc_progress",
      "whole_recent",
      "after_last_prompt_marker",
      "before_current_prompt_marker",
      "whole_recent_without_current_prompt_marker",
      "current_prompt_block_marker",
      "after_current_prompt_block_marker",
      "prompt_box_body",
      "above_prompt_box",
      "last_non_empty_above_prompt_box",
      "after_last_horizontal_rule",
    ].includes(name) ||
    /^bottom_lines\(\d+\)$/.test(name) ||
    /^bottom_non_empty_lines\(\d+\)$/.test(name) ||
    /^top_non_empty_lines\([1-9]\d*\)$/.test(name)
  );
}

// ---------------------------------------------------------------------------
// Compile and evaluate.
// ---------------------------------------------------------------------------

function compileGate(g, keys, path) {
  for (const k of Object.keys(g)) {
    if (!keys.has(k)) throw new Error(`manifest: unknown field ${k} in ${path}`);
  }
  const list = (k) => (g[k] === undefined ? [] : Array.isArray(g[k]) ? g[k] : [g[k]]);
  return {
    contains: list("contains").map((s) => String(s).toLowerCase()),
    regex: list("regex").map(translateRegex),
    line_regex: list("line_regex").map(translateRegex),
    all: list("all").map((x, n) => compileGate(x, GATE_KEYS, `${path}.all[${n}]`)),
    any: list("any").map((x, n) => compileGate(x, GATE_KEYS, `${path}.any[${n}]`)),
    not: list("not").map((x, n) => compileGate(x, GATE_KEYS, `${path}.not[${n}]`)),
  };
}

function gateMatches(g, text, lower) {
  if (!g.contains.every((n) => lower.includes(n))) return false;
  if (!g.regex.every((re) => re.test(text))) return false;
  if (g.line_regex.length > 0) {
    const ls = linesOf(text);
    if (!g.line_regex.every((re) => ls.some((l) => re.test(l)))) return false;
  }
  if (!g.all.every((x) => gateMatches(x, text, lower))) return false;
  if (g.any.length > 0 && !g.any.some((x) => gateMatches(x, text, lower))) return false;
  if (g.not.some((x) => gateMatches(x, text, lower))) return false;
  return true;
}

// doc: parsed TOML. Throws on anything herdr would reject that matters here.
export function compileManifest(doc, extraRules = []) {
  if (!doc || typeof doc.id !== "string") throw new Error("manifest: missing id");
  for (const k of Object.keys(doc)) {
    if (!HEADER_KEYS.has(k)) throw new Error(`manifest: unknown field ${k}`);
  }
  const rules = [...(Array.isArray(doc.rules) ? doc.rules : []), ...extraRules].map((r, n) => {
    if (!r || typeof r.id !== "string" || r.id.length === 0) throw new Error(`manifest: rule ${n} has no id`);
    const state = r.state ?? "unknown";
    if (!STATES.has(state)) throw new Error(`manifest: rule ${r.id} has state ${state}`);
    const reg = r.region ?? "whole_recent";
    if (!validRegion(String(reg).trim())) throw new Error(`manifest: rule ${r.id} has region ${reg}`);
    if (r.skip_state_update === true && (state !== "unknown" || r.visible_idle || r.visible_blocker || r.visible_working)) {
      throw new Error(`manifest: rule ${r.id} skips the update with a state`);
    }
    return {
      id: r.id,
      state,
      priority: Number.isInteger(r.priority) ? r.priority : 0,
      region: reg,
      visible_idle: r.visible_idle === true,
      visible_blocker: r.visible_blocker === true,
      visible_working: r.visible_working === true,
      skip: r.skip_state_update === true,
      gate: compileGate(r, RULE_KEYS, `rule ${r.id}`),
    };
  });
  return {
    id: doc.id,
    version: typeof doc.version === "string" ? doc.version : null,
    min_engine_version: Number.isInteger(doc.min_engine_version) ? doc.min_engine_version : 0,
    rules,
  };
}

const NO_MATCH = Object.freeze({
  state: "idle",
  rule: null,
  visible_idle: false,
  visible_blocker: false,
  visible_working: false,
  skip: false,
});

// input: {screen, title?, progress?} -> {state, rule, visible_*, skip}.
export function evaluate(manifest, input) {
  let best = null;
  for (const rule of manifest.rules) {
    const text = region(input, rule.region);
    if (!gateMatches(rule.gate, text, text.toLowerCase())) continue;
    if (best === null || rule.priority > best.priority) best = rule;
  }
  if (best === null) return { ...NO_MATCH };
  return {
    state: best.state,
    rule: best.id,
    visible_idle: best.visible_idle && best.state === "idle",
    visible_blocker: best.visible_blocker && best.state === "blocked",
    visible_working: best.visible_working && best.state === "working",
    skip: best.skip,
  };
}

// herdr's detection text: each row trimmed at the end, trailing empty rows
// dropped, rows joined by "\n" with one final "\n" (src/pane/terminal.rs).
export function detectionText(raw) {
  const rows = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/u, ""));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows.length === 0 ? "" : `${rows.join("\n")}\n`;
}

function compareVersions(a, b) {
  const pa = String(a ?? "").split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b ?? "").split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let k = 0; k < Math.max(pa.length, pb.length); k += 1) {
    const d = (pa[k] ?? 0) - (pb[k] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function readToml(file) {
  return parseToml(readFileSync(file, "utf8"));
}

// herdr's cache of remote manifests on this machine (read only, never written).
export function defaultRemoteDir(env = process.env) {
  if (typeof env.TERN_AGENT_MANIFEST_REMOTE_DIR === "string") {
    return env.TERN_AGENT_MANIFEST_REMOTE_DIR === "" ? null : env.TERN_AGENT_MANIFEST_REMOTE_DIR;
  }
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "herdr", "agent-detection", "remote");
  }
  return null;
}

// The manifest for one agent: herdr's (remote when newer, else bundled) plus the
// tern overlay. omp has the overlay only.
export function loadManifest(agent, { remoteDir = defaultRemoteDir(), bundledDir = BUNDLED_DIR } = {}) {
  const overlayFile = join(bundledDir, `tern-${agent}.toml`);
  const overlay = existsSync(overlayFile) ? readToml(overlayFile).rules ?? [] : [];
  const bundledFile = join(bundledDir, `${agent}.toml`);
  if (!existsSync(bundledFile)) {
    return compileManifest({ id: agent, version: "tern", rules: [] }, overlay);
  }
  const bundled = compileManifest(readToml(bundledFile), overlay);
  if (remoteDir) {
    const remoteFile = join(remoteDir, `${agent}.toml`);
    if (existsSync(remoteFile)) {
      try {
        const doc = readToml(remoteFile);
        const remote = compileManifest(doc, overlay);
        if (
          remote.id === agent &&
          remote.version !== null &&
          Number.isInteger(doc.min_engine_version) &&
          remote.min_engine_version <= ENGINE_VERSION &&
          compareVersions(remote.version, bundled.version) >= 0
        ) {
          return remote;
        }
      } catch {
        // A remote copy that does not compile is ignored, as herdr does.
      }
    }
  }
  return bundled;
}

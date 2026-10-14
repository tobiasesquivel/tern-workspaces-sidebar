// runtime/server.test.mjs — the daemon's wiring: discovery, the detection loop,
// the notifier. Fake tern, isolated data dirs, no spawn.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./server.mjs";

const SHELL = { pane: 0, child: { pid: 1, name: "powershell.exe", argv: [] }, group: 1, foreground: { pid: 1, name: "powershell.exe", argv: [] } };
const OMP = { pane: 0, child: { pid: 1, name: "powershell.exe", argv: [] }, group: 9, foreground: { pid: 9, name: "omp.exe", argv: [] } };
const CLAUDE = { pane: 0, child: { pid: 1, name: "powershell.exe", argv: [] }, group: 7, foreground: { pid: 7, name: "claude.exe", argv: [] } };

async function withDaemon(tern, fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rt-server-"));
  const played = [];
  const handle = await serve({
    dataDir: dir,
    tern,
    pollMs: 3600000,
    discoveryMs: 0,
    detection: false,
    playChime: (k) => played.push(k),
    ...opts,
  });
  try {
    await fn({ handle, dir, played });
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function lsOf(blocks) {
  return { sessions: [{ id: 1, tabs: [{ id: 2, blocks }] }], detached: [] };
}

describe("discovery (bug: a stale native entry blocked start)", () => {
  it("a block Tern still marks as an agent, whose pane is back at its shell, is no agent", async () => {
    const tern = {
      async list() {
        return lsOf([{ id: 600, kind: "agent", title: "π > scratch", program: "powershell.exe" }]);
      },
      async process() {
        return SHELL;
      },
      async capture() {
        return { text: "" };
      },
    };
    await withDaemon(tern, async ({ handle }) => {
      await handle.ingest();
      assert.throws(() => handle.state.get(600), (e) => e.code === "agent_not_found");
    });
  });

  it("an omp the rail listed, then /exit: the loop's probe frees the pane and start can claim it", async () => {
    let proc = OMP;
    const tern = {
      async list() {
        return lsOf([{ id: 601, title: "x", program: "powershell.exe" }]);
      },
      async process() {
        return proc;
      },
      async capture() {
        return { text: "" };
      },
    };
    await withDaemon(tern, async ({ handle, dir }) => {
      const obs = join(dir, "observation-vm-a.json");
      const write = (agents, n) => {
        writeFileSync(obs, JSON.stringify({ v: 1, generation: "vm-a", seq: n, observed_at: Date.now(), agents, panes: [{ pane: 601, tab: 2 }] }));
        const t = Date.now() / 1000 + n;
        utimesSync(obs, t, t);
      };
      write([{ pane: 601, agent: "omp", state: "idle" }], 1);
      await handle.ingest();
      assert.equal(handle.state.get(601).agent, "omp");
      proc = SHELL;
      // The rail keeps naming the pane (a stale native list), the loop probes it.
      write([{ pane: 601, agent: "omp", state: "unknown" }], 2);
      await handle.detection.step();
      for (const tr of handle.detection.tracks.values()) tr.nextProbeAt = 0;
      await handle.detection.step();
      await handle.ingest();
      assert.throws(() => handle.state.get(601), (e) => e.code === "agent_not_found");
      const cmds = await import("./commands.mjs");
      void cmds;
      assert.equal(handle.state.list().some((a) => a.pane_id === 601), false, "start finds the pane free");
    });
  });

  it("a Claude opened by hand is discovered unknown and left to the loop's screen reads", async () => {
    let captures = 0;
    const tern = {
      async list() {
        return lsOf([{ id: 602, title: "✳ Claude Code", program: "powershell.exe" }]);
      },
      async process() {
        return CLAUDE;
      },
      async capture() {
        captures += 1;
        return { text: "──────\n❯ \n──────\n" };
      },
    };
    await withDaemon(tern, async ({ handle }) => {
      await handle.ingest();
      assert.deepEqual([handle.state.get(602).agent, handle.state.get(602).agent_status], ["claude", "unknown"]);
      assert.equal(captures, 0, "discovery itself reads no screen");
      const tr = handle.detection.tracks.get(602) ?? (await handle.detection.step(), handle.detection.tracks.get(602));
      tr.graceUntil = 0;
      tr.nextScreenAt = 0;
      await handle.detection.step();
      assert.equal(handle.state.get(602).agent_status, "idle");
    });
  });
});

describe("notifications (the daemon owns the sounds)", () => {
  it("plays done for a background completion after the delay, and ignores the rail's chime", async () => {
    await withDaemon(null, async ({ handle, dir, played }) => {
      const obs = join(dir, "observation-vm-b.json");
      writeFileSync(obs, JSON.stringify({ v: 1, generation: "vm-b", seq: 1, observed_at: Date.now(), agents: [], panes: [], chime: { seq: 1, kind: "request", at: Date.now() } }));
      await handle.ingest();
      assert.deepEqual(played, [], "the rail's chime is not played twice");
      handle.state.claim({ pane_id: 700, agent: "omp", launch_id: "L700" });
      const R = (extra) => handle.state.report({ v: 1, pane_id: 700, launch_id: "L700", source: "tern:omp", agent: "omp", session_epoch: 0, ...extra });
      R({ state: "working", seq: 1 });
      R({ state: "idle", seq: 2 });
      await new Promise((r) => setTimeout(r, 60));
      assert.deepEqual(played, ["done"]);
    }, { notifyDelayMs: 30 });
  });

  it("the rail's mute silences the daemon", async () => {
    await withDaemon(null, async ({ handle, dir, played }) => {
      const obs = join(dir, "observation-vm-c.json");
      writeFileSync(obs, JSON.stringify({ v: 1, generation: "vm-c", seq: 1, observed_at: Date.now(), agents: [], panes: [], sound: false }));
      await handle.ingest();
      handle.state.claim({ pane_id: 701, agent: "omp", launch_id: "L701" });
      const R = (extra) => handle.state.report({ v: 1, pane_id: 701, launch_id: "L701", source: "tern:omp", agent: "omp", session_epoch: 0, ...extra });
      R({ state: "working", seq: 1 });
      R({ state: "blocked", seq: 2, message: "q" });
      await new Promise((r) => setTimeout(r, 60));
      assert.deepEqual(played, []);
    }, { notifyDelayMs: 30 });
  });
});

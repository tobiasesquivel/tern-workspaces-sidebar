// Behavioral tests for runtime/commands.mjs (+ CLI plumbing in cli.mjs,
// helpers in tern.mjs). Run: `node --test runtime/cli.test.mjs`.
// Uses fakes for { state, tern, clock }; never touches a real daemon,
// window, or pane. Not executed by task owners; parent runs suites after
// integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCommands } from './commands.mjs';
import { main } from './cli.mjs';

function stateError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function makeClock(start = 1_000_000) {
  let now = start;
  const sleeps = [];
  return {
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

function agentFixture(over = {}) {
  return {
    terminal_id: 'term-7',
    name: 'scout',
    agent: 'omp',
    pane_id: 7,
    agent_status: 'idle',
    state_change_seq: 5,
    completion_seq: null,
    focused: false,
    interactive_ready: true,
    launch_pending: false,
    message: null,
    agent_session: null,
    resume_argv: null,
    workspace_id: 11,
    tab_id: 12,
    cwd: null,
    failed: false,
    source: 'tern:omp',
    ...over,
  };
}

// Minimal RuntimeState double: get by name or String(pane_id), list,
// claim, release. getImpl(target, self) overrides resolution.
function makeState(agents = [], { getImpl, onClaim, onRelease } = {}) {
  const byName = new Map();
  const byPane = new Map();
  for (const a of agents) {
    if (a.name) byName.set(a.name, a);
    byPane.set(String(a.pane_id), a);
  }
  return {
    byName,
    byPane,
    getCalls: [],
    claimCalls: [],
    releaseCalls: [],
    list() {
      return [...byPane.values()];
    },
    get(target) {
      this.getCalls.push(target);
      if (getImpl) return getImpl(target, this);
      const key = String(target);
      if (byName.has(key)) return byName.get(key);
      if (byPane.has(key)) return byPane.get(key);
      throw stateError('agent_not_found', `agent not found: ${key}`);
    },
    claim(c) {
      this.claimCalls.push(c);
      if (onClaim) return onClaim(c);
      const a = agentFixture({
        terminal_id: `term-${c.pane_id}`,
        name: c.name ?? null,
        agent: c.agent,
        pane_id: c.pane_id,
        agent_status: 'working',
        state_change_seq: 1,
        interactive_ready: false,
        launch_pending: true,
      });
      if (a.name) byName.set(a.name, a);
      byPane.set(String(a.pane_id), a);
      return a;
    },
    release(r) {
      this.releaseCalls.push(r);
      if (onRelease) return onRelease(r);
    },
  };
}

function makeTern(over = {}) {
  const calls = { capture: [], send: [], runNode: [], process: [], findPane: [] };
  const inner = {
    calls,
    async capture(pane, opts) {
      calls.capture.push([pane, opts]);
      return over.captureReturn ?? { text: '' };
    },
    async send(pane, kind, ...payload) {
      calls.send.push([pane, kind, ...payload]);
      if (over.sendImpl) return over.sendImpl(pane, kind, ...payload);
      return { ok: true };
    },
    async runNode(pane, argv) {
      calls.runNode.push([pane, argv]);
      if (over.runNodeImpl) return over.runNodeImpl(pane, argv);
      if (over.runImpl) return over.runImpl(pane, argv);
      return { ok: true };
    },
    async process(pane) {
      calls.process.push(pane);
      if (over.processImpl) return over.processImpl(pane);
      return { pane: Number(pane) };
    },
    async findPane(pane) {
      calls.findPane.push(pane);
      if (over.findPaneImpl) return over.findPaneImpl(pane);
      return { session: {}, tab: {}, block: { id: Number(pane) } };
    },
  };
  return inner;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err?.code, code, `expected code ${code}, got ${err?.code}: ${err?.message}`);
    return true;
  });
}

describe('wait', () => {
  it('matches idle immediately under default until without sleeping', async () => {
    const clock = makeClock();
    const state = makeState([agentFixture({ agent_status: 'idle' })]);
    const { wait } = createCommands({ state, tern: makeTern(), dataDir: '/tmp/rt', clock });
    const out = await wait({ target: 'scout' });
    assert.equal(out.type, 'agent_info');
    assert.equal(out.agent.agent_status, 'idle');
    assert.equal(clock.sleeps.length, 0);
  });

  it('defaults to idle|done|blocked: done matches, unknown times out', async () => {
    const clock = makeClock();
    const done = createCommands({
      state: makeState([agentFixture({ agent_status: 'done' })]),
      tern: makeTern(),
      dataDir: '/tmp/rt',
      clock,
    });
    assert.equal((await done.wait({ target: 'scout' })).agent.agent_status, 'done');

    const clock2 = makeClock();
    const unknown = createCommands({
      state: makeState([agentFixture({ agent_status: 'unknown', state_change_seq: 9 })]),
      tern: makeTern(),
      dataDir: '/tmp/rt',
      clock: clock2,
    });
    await rejectsCode(unknown.wait({ target: 'scout', timeout: 250 }), 'timeout');
  });

  it('matches unknown only when explicitly requested', async () => {
    const clock = makeClock();
    const { wait } = createCommands({
      state: makeState([agentFixture({ agent_status: 'unknown' })]),
      tern: makeTern(),
      dataDir: '/tmp/rt',
      clock,
    });
    const out = await wait({ target: 'scout', until: ['unknown'] });
    assert.equal(out.agent.agent_status, 'unknown');
  });

  it('rejects invalid until values', async () => {
    const { wait } = createCommands({
      state: makeState([agentFixture()]),
      tern: makeTern(),
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    await rejectsCode(wait({ target: 'scout', until: ['exited'] }), 'invalid_argument');
  });

  it('pins identity: occupant replacement becomes agent_not_running', async () => {
    let n = 0;
    const first = agentFixture({ agent_status: 'working', state_change_seq: 5 });
    const replacement = agentFixture({ agent_status: 'idle', state_change_seq: 6, terminal_id: 'term-other' });
    const state = makeState([], {
      getImpl: () => (n++ === 0 ? first : replacement),
    });
    const { wait } = createCommands({ state, tern: makeTern(), dataDir: '/tmp/rt', clock: makeClock() });
    await rejectsCode(wait({ target: 'scout', until: ['idle'], timeout: 1000 }), 'agent_not_running');
  });

  it('mid-wait disappearance becomes agent_not_running, not agent_not_found', async () => {
    let n = 0;
    const state = makeState([], {
      getImpl: () => {
        if (n++ === 0) return agentFixture({ agent_status: 'working', state_change_seq: 5 });
        throw stateError('agent_not_found', 'gone');
      },
    });
    const { wait } = createCommands({ state, tern: makeTern(), dataDir: '/tmp/rt', clock: makeClock() });
    await rejectsCode(wait({ target: 'scout', until: ['idle'], timeout: 1000 }), 'agent_not_running');
  });

  it('polls until the status arrives, then returns the fresh agent', async () => {
    let n = 0;
    const state = makeState([], {
      getImpl: () => {
        n++;
        return n < 3
          ? agentFixture({ agent_status: 'working', state_change_seq: 5 })
          : agentFixture({ agent_status: 'idle', state_change_seq: 6 });
      },
    });
    const clock = makeClock();
    const { wait } = createCommands({ state, tern: makeTern(), dataDir: '/tmp/rt', clock });
    const out = await wait({ target: 'scout', until: ['idle'], timeout: 5000 });
    assert.equal(out.agent.agent_status, 'idle');
    assert.equal(out.agent.state_change_seq, 6);
    assert.ok(clock.sleeps.length > 0);
  });

  it('rejects negative and non-integer timeouts', async () => {
    const { wait } = createCommands({
      state: makeState([agentFixture()]),
      tern: makeTern(),
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    await rejectsCode(wait({ target: 'scout', timeout: -1 }), 'invalid_argument');
    await rejectsCode(wait({ target: 'scout', timeout: 1.5 }), 'invalid_argument');
  });
});

describe('prompt', () => {
  it('rejects a blocked agent before writing anything', async () => {
    const tern = makeTern();
    const { prompt } = createCommands({
      state: makeState([agentFixture({ agent_status: 'blocked', message: 'permission?' })]),
      tern,
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    await rejectsCode(prompt({ target: 'scout', text: 'hi' }), 'agent_blocked');
    assert.equal(tern.calls.send.length, 0);
  });

  it('sends paste, waits 300ms, then Enter, and returns the sent snapshot without --wait', async () => {
    const clock = makeClock();
    const tern = makeTern();
    const sent = agentFixture({ agent_status: 'idle', state_change_seq: 5 });
    const { prompt } = createCommands({
      state: makeState([sent]),
      tern,
      dataDir: '/tmp/rt',
      clock,
    });
    const out = await prompt({ target: 'scout', text: 'hello' });
    assert.equal(out.type, 'agent_prompted');
    assert.deepEqual(
      tern.calls.send.map((c) => c.slice(1)),
      [['paste', 'hello'], ['keys', 'Enter']],
    );
    assert.ok(clock.sleeps.includes(300), 'submit delay must elapse between paste and Enter');
  });

  it('rejects empty and whitespace-only text before touching the terminal', async () => {
    const tern = makeTern();
    const { prompt } = createCommands({
      state: makeState([agentFixture()]),
      tern,
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    await rejectsCode(prompt({ target: 'scout', text: '' }), 'empty_agent_prompt');
    await rejectsCode(prompt({ target: 'scout', text: '   \n\t ' }), 'empty_agent_prompt');
    assert.equal(tern.calls.send.length, 0);
  });

  it('rejects not-ready agents (launch pending, unknown, not interactive)', async () => {
    for (const over of [
      { launch_pending: true },
      { agent_status: 'unknown' },
      { interactive_ready: false },
    ]) {
      const tern = makeTern();
      const { prompt } = createCommands({
        state: makeState([agentFixture(over)]),
        tern,
        dataDir: '/tmp/rt',
        clock: makeClock(),
      });
      await rejectsCode(prompt({ target: 'scout', text: 'go' }), 'agent_not_ready');
      assert.equal(tern.calls.send.length, 0);
    }
  });

  it('--wait from idle requires observed working|blocked within 5s, else stalled', async () => {
    const frozen = agentFixture({ agent_status: 'idle', state_change_seq: 5 });
    const clock = makeClock();
    const { prompt } = createCommands({
      state: makeState([frozen]),
      tern: makeTern(),
      dataDir: '/tmp/rt',
      clock,
    });
    await rejectsCode(prompt({ target: 'scout', text: 'go', wait: true }), 'agent_prompt_stalled');
    assert.ok(clock.now() - 1_000_000 >= 5000, 'gate must wait the full 5s window');
  });

  it('--wait accepts a fast turn that completes between polls via completion_seq', async () => {
    let n = 0;
    const state = makeState([], {
      getImpl: () => {
        n++;
        if (n === 1) return agentFixture({ agent_status: 'idle', state_change_seq: 5, completion_seq: null });
        // Turn ran and finished before the first gate poll observed working.
        return agentFixture({ agent_status: 'idle', state_change_seq: 6, completion_seq: 6 });
      },
    });
    const { prompt } = createCommands({ state, tern: makeTern(), dataDir: '/tmp/rt', clock: makeClock() });
    const out = await prompt({ target: 'scout', text: 'go', wait: true, until: ['idle'], timeout: 30_000 });
    assert.equal(out.agent.agent_status, 'idle');
    assert.equal(out.agent.completion_seq, 6);
  });

  it('--wait with a budget under 5s returns timeout instead of stalled', async () => {
    const frozen = agentFixture({ agent_status: 'idle', state_change_seq: 5 });
    const { prompt } = createCommands({
      state: makeState([frozen]),
      tern: makeTern(),
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    await rejectsCode(prompt({ target: 'scout', text: 'go', wait: true, timeout: 1000 }), 'timeout');
  });

  it('--wait observes the submit delay inside the overall timeout', async () => {
    // Deterministic clock phases: acceptance t0, paste t0, 300ms submit
    // delay, Enter t0+300, gate polls from submit completion. The fake
    // clock advances only via sleep(), so phases are exact, not wall-time.
    const clock = makeClock();
    const seen = [];
    const tern = makeTern({
      sendImpl: (pane, kind) => {
        seen.push([kind, clock.now() - 1_000_000]);
        return { ok: true };
      },
    });
    let n = 0;
    const state = makeState([], {
      getImpl: () => {
        n++;
        if (n === 1) return agentFixture({ agent_status: 'idle', state_change_seq: 5 });
        if (clock.now() - 1_000_000 < 300 + 5000) {
          return agentFixture({ agent_status: 'idle', state_change_seq: 5 });
        }
        return agentFixture({ agent_status: 'working', state_change_seq: 6 });
      },
    });
    const { prompt } = createCommands({ state, tern, dataDir: '/tmp/rt', clock });
    const out = await prompt({ target: 'scout', text: 'go', wait: true, until: ['working'], timeout: 30000 });
    assert.equal(out.agent.agent_status, 'working');
    assert.deepEqual(seen.map(([k]) => k), ['paste', 'keys']);
    assert.ok(seen[1][1] - seen[0][1] >= 300, 'Enter must follow paste by the 300ms submit delay');
  });

  it('--wait from working skips the gate and matches the active turn completion', async () => {
    let n = 0;
    const state = makeState([], {
      getImpl: () => {
        n++;
        return n === 1
          ? agentFixture({ agent_status: 'working', state_change_seq: 5 })
          : agentFixture({ agent_status: 'idle', state_change_seq: 6 });
      },
    });
    const clock = makeClock();
    const { prompt } = createCommands({ state, tern: makeTern(), dataDir: '/tmp/rt', clock });
    const out = await prompt({ target: 'scout', text: 'go', wait: true, timeout: 30_000 });
    assert.equal(out.type, 'agent_prompted');
    assert.equal(out.agent.agent_status, 'idle');
  });

  it('--wait observes the gate then settles on the requested state', async () => {
    let n = 0;
    const state = makeState([], {
      getImpl: () => {
        n++;
        if (n === 1) return agentFixture({ agent_status: 'idle', state_change_seq: 5 });
        if (n < 4) return agentFixture({ agent_status: 'working', state_change_seq: 6 });
        return agentFixture({ agent_status: 'idle', state_change_seq: 7 });
      },
    });
    const { prompt } = createCommands({ state, tern: makeTern(), dataDir: '/tmp/rt', clock: makeClock() });
    const out = await prompt({ target: 'scout', text: 'go', wait: true, until: ['idle'], timeout: 30_000 });
    assert.equal(out.agent.agent_status, 'idle');
    assert.equal(out.agent.state_change_seq, 7);
  });

  it('send failure surfaces agent_prompt_failed', async () => {
    const tern = makeTern({
      sendImpl: () => {
        throw new Error('no ptmx');
      },
    });
    const { prompt } = createCommands({
      state: makeState([agentFixture()]),
      tern,
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    await rejectsCode(prompt({ target: 'scout', text: 'go' }), 'agent_prompt_failed');
  });
});

describe('read', () => {
  it('returns recent text with revision 0 and pane/tab context', async () => {
    const tern = makeTern({ captureReturn: { text: 'a\nb\nc\n' } });
    const { read } = createCommands({
      state: makeState([agentFixture()]),
      tern,
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    const out = await read({ target: 'scout' });
    assert.equal(out.type, 'pane_read');
    assert.equal(out.read.text, 'a\nb\nc');
    assert.equal(out.read.revision, 0);
    assert.equal(out.read.truncated, false);
    assert.equal(out.read.source, 'recent');
    assert.equal(out.read.format, 'text');
    assert.equal(out.read.pane_id, 7);
    assert.deepEqual(tern.calls.capture, [['7', { scrollback: true, surfaces: true, ansi: false }]]);
  });

  it('strips ANSI by default and preserves it with --ansi', async () => {
    const raw = '\x1b[32mgreen\x1b[0m plain';
    const stripped = createCommands({
      state: makeState([agentFixture()]),
      tern: makeTern({ captureReturn: { text: raw } }),
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    assert.equal((await stripped.read({ target: 'scout' })).read.text, 'green plain');

    const kept = createCommands({
      state: makeState([agentFixture()]),
      tern: makeTern({ captureReturn: { text: raw } }),
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    const out = await kept.read({ target: 'scout', ansi: true });
    assert.equal(out.read.format, 'ansi');
    assert.ok(out.read.text.includes('\x1b[32m'));
  });

  it('returns the last N lines and flags truncation', async () => {
    const { read } = createCommands({
      state: makeState([agentFixture()]),
      tern: makeTern({ captureReturn: { text: 'l1\nl2\nl3\nl4\nl5\n' } }),
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    const out = await read({ target: 'scout', lines: 2 });
    assert.equal(out.read.text, 'l4\nl5');
    assert.equal(out.read.truncated, true);
  });

  it('caps lines at 1000 (herdr parity)', async () => {
    const big = Array.from({ length: 1500 }, (_, i) => `line-${i}`).join('\n');
    const { read } = createCommands({
      state: makeState([agentFixture()]),
      tern: makeTern({ captureReturn: { text: big } }),
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    const out = await read({ target: 'scout', lines: 5000 });
    assert.equal(out.read.text.split('\n').length, 1000);
    assert.equal(out.read.text.split('\n')[0], 'line-500');
    assert.equal(out.read.truncated, true);
  });

  it('maps sources to capture flags: visible bare, recent/detection with surfaces', async () => {
    const tern = makeTern({ captureReturn: { text: 'x' } });
    const { read } = createCommands({
      state: makeState([agentFixture()]),
      tern,
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    await read({ target: 'scout', source: 'visible' });
    await read({ target: 'scout', source: 'recent' });
    await read({ target: 'scout', source: 'detection' });
    assert.deepEqual(tern.calls.capture[0], ['7', { scrollback: false, surfaces: false, ansi: false }]);
    assert.deepEqual(tern.calls.capture[1], ['7', { scrollback: true, surfaces: true, ansi: false }]);
    assert.deepEqual(tern.calls.capture[2], ['7', { scrollback: true, surfaces: true, ansi: false }]);
  });

  it('rejects invalid source, format, and lines', async () => {
    const { read } = createCommands({
      state: makeState([agentFixture()]),
      tern: makeTern({ captureReturn: { text: 'x' } }),
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    await rejectsCode(read({ target: 'scout', source: 'bogus' }), 'invalid_argument');
    await rejectsCode(read({ target: 'scout', format: 'html' }), 'invalid_argument');
    await rejectsCode(read({ target: 'scout', lines: 0 }), 'invalid_argument');
    await rejectsCode(read({ target: 'scout', lines: -3 }), 'invalid_argument');
  });

  it('missing agent surfaces agent_not_found without calling capture', async () => {
    const tern = makeTern();
    const { read } = createCommands({
      state: makeState([]),
      tern,
      dataDir: '/tmp/rt',
      clock: makeClock(),
    });
    await rejectsCode(read({ target: 'ghost' }), 'agent_not_found');
    assert.equal(tern.calls.capture.length, 0);
  });
});

describe('start', () => {
  function readyWorld(over = {}) {
    const clock = makeClock();
    const tern = makeTern({
      findPaneImpl: (pane) => ({ session: { id: 1 }, tab: { id: 2 }, block: { id: Number(pane) } }),
      ...over.ternOver,
    });
    const agents = over.existing ?? [];
    const state = makeState(agents, {
      getImpl: over.getImpl,
      onClaim: over.onClaim,
    });
    // Default: name free on pre-check, ready agent afterwards.
    if (!over.getImpl) {
      let n = 0;
      const ready = agentFixture({
        name: over.name ?? 'bot',
        agent: over.kind ?? 'omp',
        pane_id: over.pane ?? 9,
        terminal_id: `term-${over.pane ?? 9}`,
        agent_status: 'idle',
        state_change_seq: 2,
        interactive_ready: true,
        launch_pending: false,
      });
      state.get = ((orig) => (target) => {
        state.getCalls.push(target);
        if (n++ === 0) throw stateError('agent_not_found', 'free');
        return ready;
      })(state.get.bind(state));
    }
    return { clock, tern, state };
  }

  it('validates name, kind, and timeout before touching panes', async () => {
    const { clock, tern, state } = readyWorld();
    const { start } = createCommands({ state, tern, dataDir: '/tmp/rt', clock });
    await rejectsCode(start({ name: 'Bad name', kind: 'omp', pane: 9 }), 'invalid_agent_name');
    await rejectsCode(start({ name: 'bot', kind: 'emacs', pane: 9 }), 'unsupported_agent_kind');
    await rejectsCode(start({ name: 'bot', kind: 'omp', pane: 9, timeout: 3000 }), 'invalid_agent_timeout');
    await rejectsCode(start({ name: 'bot', kind: 'omp', pane: 9, timeout: 300001 }), 'invalid_agent_timeout');
    assert.equal(tern.calls.findPane.length, 0);
    assert.equal(tern.calls.runNode.length, 0);
  });

  it('rejects control characters in agent args', async () => {
    const { clock, tern, state } = readyWorld();
    const { start } = createCommands({ state, tern, dataDir: '/tmp/rt', clock });
    await rejectsCode(start({ name: 'bot', kind: 'omp', pane: 9, args: ['ok', 'bad\x07'] }), 'invalid_agent_argument');
    assert.equal(tern.calls.runNode.length, 0);
  });

  it('requires an existing, agent-free pane', async () => {
    const missing = readyWorld({ ternOver: { findPaneImpl: () => null } });
    const s1 = createCommands({ state: missing.state, tern: missing.tern, dataDir: '/tmp/rt', clock: missing.clock });
    await rejectsCode(s1.start({ name: 'bot', kind: 'omp', pane: 4242 }), 'agent_pane_not_found');

    const busy = readyWorld({ existing: [agentFixture({ name: 'other', pane_id: 9, terminal_id: 'term-9' })] });
    // Pre-check for 'bot' must still report free while pane 9 is occupied.
    let n = 0;
    const origGet = busy.state.get.bind(busy.state);
    busy.state.get = (target) => {
      busy.state.getCalls.push(target);
      if (String(target) === 'bot' && n++ === 0) throw stateError('agent_not_found', 'free');
      return origGet(target);
    };
    const s2 = createCommands({ state: busy.state, tern: busy.tern, dataDir: '/tmp/rt', clock: busy.clock });
    await rejectsCode(s2.start({ name: 'bot', kind: 'omp', pane: 9 }), 'agent_pane_busy');
  });

  it('refuses a taken name without running anything', async () => {
    const tern = makeTern();
    const state = makeState([agentFixture({ name: 'bot', pane_id: 3, terminal_id: 'term-3' })]);
    const { start } = createCommands({ state, tern, dataDir: '/tmp/rt', clock: makeClock() });
    await rejectsCode(start({ name: 'bot', kind: 'omp', pane: 9 }), 'agent_name_taken');
    assert.equal(tern.calls.runNode.length, 0);
  });

  it('claims before runNode and invokes the wrapper with pinned launch identity', async () => {
    const { clock, tern, state } = readyWorld({ name: 'bot', kind: 'codex', pane: 9 });
    const { start } = createCommands({ state, tern, dataDir: '/d', clock });
    const out = await start({ name: 'bot', kind: 'codex', pane: 9, args: ['--fast'] });
    assert.equal(out.type, 'agent_started');
    assert.equal(state.claimCalls.length, 1);
    assert.equal(state.claimCalls[0].name, 'bot');
    const launchId = state.claimCalls[0].launch_id;
    assert.ok(typeof launchId === 'string' && launchId.length > 0);
    // Shell-independent launch goes through runNode only.
    assert.equal(tern.calls.runNode.length, 1);
    const [pane, argv] = tern.calls.runNode[0];
    assert.equal(pane, '9');
    const tail = argv.slice(1);
    assert.ok(tail[0].endsWith('launch.mjs'), `wrapper must be launch.mjs, got ${tail[0]}`);
    const head = argv.slice(1, 8);
    assert.deepEqual(head.slice(1, 7), ['--agent', 'codex', '--data-dir', '/d', '--launch-id', launchId]);
    assert.equal(argv[argv.length - 1], '--fast');
    assert.ok(argv.includes('--'));
  });

  it('keeps full pane ids above 2^32 (no bitwise truncation)', async () => {
    const big = 4294967299;
    const { clock, tern, state } = readyWorld({ name: 'bot', kind: 'omp', pane: big });
    const { start } = createCommands({ state, tern, dataDir: '/d', clock });
    await start({ name: 'bot', kind: 'omp', pane: big });
    assert.equal(tern.calls.findPane[0], big);
    assert.equal(tern.calls.runNode[0][0], String(big));
    assert.equal(state.claimCalls[0].pane_id, big);
  });

  it('run failure releases the claim and reports transport failure', async () => {
    const { clock, tern, state } = readyWorld({
      ternOver: {
        runImpl: () => {
          throw new Error('denied');
        },
      },
    });
    const { start } = createCommands({ state, tern, dataDir: '/d', clock });
    await rejectsCode(start({ name: 'bot', kind: 'omp', pane: 9 }), 'agent_start_transport_failed');
    assert.equal(state.releaseCalls.length, 1);
  });

  it('readiness: kind mismatch, blocked, and early exit map to herdr codes', async () => {
    for (const [agentOver, code] of [
      [{ agent: 'claude' }, 'agent_kind_mismatch'],
      [{ agent_status: 'blocked', message: 'auth?' }, 'agent_not_ready'],
      [{ agent_status: 'idle', interactive_ready: false, launch_pending: false }, 'agent_start_failed'],
    ]) {
      let n = 0;
      const ready = agentFixture({ name: 'bot', pane_id: 9, terminal_id: 'term-9', ...agentOver });
      const state = makeState([], {
        getImpl: (target) => {
          state.getCalls.push(target);
          if (n++ === 0) throw stateError('agent_not_found', 'free');
          return ready;
        },
      });
      const tern = makeTern({ findPaneImpl: (pane) => ({ block: { id: Number(pane) } }) });
      const { start } = createCommands({ state, tern, dataDir: '/d', clock: makeClock() });
      await rejectsCode(start({ name: 'bot', kind: 'omp', pane: 9, timeout: 5000 }), code);
    }
  });
  it('readiness: unknown with ready:true still waits, unknown with ready:false is not success', async () => {
    // claude/codex SessionStart reports unknown + ready:false: state alone
    // must never count as readiness, even with interactive_ready somehow set.
    let n = 0;
    const state = makeState([], {
      getImpl: (target) => {
        state.getCalls.push(target);
        if (n++ === 0) throw stateError('agent_not_found', 'free');
        return agentFixture({
          name: 'bot',
          agent: 'claude',
          pane_id: 9,
          terminal_id: 'term-9',
          agent_status: 'unknown',
          interactive_ready: true,
          launch_pending: true,
        });
      },
    });
    const tern = makeTern({ findPaneImpl: (pane) => ({ block: { id: Number(pane) } }) });
    const { start } = createCommands({ state, tern, dataDir: '/d', clock: makeClock() });
    await rejectsCode(start({ name: 'bot', kind: 'claude', pane: 9, timeout: 3500 }), 'timeout');
  });

  it('readiness: occupant replacement during startup is agent_name_not_found', async () => {
    let n = 0;
    const state = makeState([], {
      getImpl: (target) => {
        state.getCalls.push(target);
        if (n++ === 0) throw stateError('agent_not_found', 'free');
        return agentFixture({ name: 'bot', pane_id: 9, terminal_id: 'term-impostor', agent_status: 'idle' });
      },
    });
    const tern = makeTern({ findPaneImpl: (pane) => ({ block: { id: Number(pane) } }) });
    const { start } = createCommands({ state, tern, dataDir: '/d', clock: makeClock() });
    await rejectsCode(start({ name: 'bot', kind: 'omp', pane: 9, timeout: 5000 }), 'agent_name_not_found');
  });

  it('readiness timeout mentions startup', async () => {
    let n = 0;
    const state = makeState([], {
      getImpl: (target) => {
        state.getCalls.push(target);
        if (n++ === 0) throw stateError('agent_not_found', 'free');
        return agentFixture({
          name: 'bot',
          pane_id: 9,
          terminal_id: 'term-9',
          agent_status: 'working',
          interactive_ready: false,
          launch_pending: true,
        });
      },
    });
    const tern = makeTern({ findPaneImpl: (pane) => ({ block: { id: Number(pane) } }) });
    const { start } = createCommands({ state, tern, dataDir: '/d', clock: makeClock() });
    await rejectsCode(start({ name: 'bot', kind: 'omp', pane: 9, timeout: 3500 }), 'timeout');
  });
  it('readiness settles: flash idle+ready followed by crash fails, not success', async () => {
    // Deterministic quick-crash: native hint idle+ready, then the occupant
    // vanishes (connector crash) before the 3s settle completes.
    let n = 0;
    const state = makeState([], {
      getImpl: (target) => {
        state.getCalls.push(target);
        n++;
        if (n === 1) throw stateError('agent_not_found', 'free');
        if (n <= 4) {
          return agentFixture({
            name: 'bot', agent: 'omp', pane_id: 9, terminal_id: 'term-9',
            agent_status: 'idle', state_change_seq: 2,
            interactive_ready: true, launch_pending: false,
          });
        }
        throw stateError('agent_not_found', 'crashed');
      },
    });
    const tern = makeTern({ findPaneImpl: (pane) => ({ block: { id: Number(pane) } }) });
    const { start } = createCommands({ state, tern, dataDir: '/d', clock: makeClock() });
    await rejectsCode(start({ name: 'bot', kind: 'omp', pane: 9, timeout: 30000 }), 'agent_name_not_found');
  });

  it('readiness settles: state change during settle restarts the window', async () => {
    let n = 0;
    const state = makeState([], {
      getImpl: (target) => {
        state.getCalls.push(target);
        n++;
        if (n === 1) throw stateError('agent_not_found', 'free');
        // working blip mid-settle resets; final stable idle+ready succeeds.
        if (n <= 30) {
          return agentFixture({
            name: 'bot', agent: 'omp', pane_id: 9, terminal_id: 'term-9',
            agent_status: 'idle', state_change_seq: n < 10 ? 2 : 3,
            interactive_ready: true, launch_pending: false,
          });
        }
        return agentFixture({
          name: 'bot', agent: 'omp', pane_id: 9, terminal_id: 'term-9',
          agent_status: 'idle', state_change_seq: 4,
          interactive_ready: true, launch_pending: false,
        });
      },
    });
    const clock = makeClock();
    const tern = makeTern({ findPaneImpl: (pane) => ({ block: { id: Number(pane) } }) });
    const { start } = createCommands({ state, tern, dataDir: '/d', clock });
    const out = await start({ name: 'bot', kind: 'omp', pane: 9, timeout: 30000 });
    assert.equal(out.type, 'agent_started');
    assert.ok(clock.now() - 1_000_000 >= 3000, 'settle window must elapse before success');
  });

  it('readiness settles: a readiness flip with no state change still starts the window', async () => {
    // Measured with codex 0.159.1: the occupant is the claim's own idle, and the
    // prompt-box evidence only flips interactive_ready (by design that moves no
    // state_change_seq). start ran its whole timeout on a ready agent.
    let n = 0;
    const state = makeState([], {
      getImpl: (target) => {
        state.getCalls.push(target);
        n++;
        if (n === 1) throw stateError('agent_not_found', 'free');
        return agentFixture({
          name: 'bot', agent: 'codex', pane_id: 9, terminal_id: 'term-9',
          agent_status: 'idle', state_change_seq: 2,
          interactive_ready: n > 5, launch_pending: n <= 5,
        });
      },
    });
    const clock = makeClock();
    const tern = makeTern({ findPaneImpl: (pane) => ({ block: { id: Number(pane) } }) });
    const { start } = createCommands({ state, tern, dataDir: '/d', clock });
    const out = await start({ name: 'bot', kind: 'codex', pane: 9, timeout: 30000 });
    assert.equal(out.type, 'agent_started');
  });

});

describe('tern helpers', () => {
  it('resolveTernBinary prefers explicit, then TERN_BIN, then conventional install', async () => {
    const { resolveTernBinary } = await import('./tern.mjs');
    assert.equal(resolveTernBinary('/custom/tern.com'), '/custom/tern.com');
    const prev = process.env.TERN_BIN;
    process.env.TERN_BIN = '/env/tern.com';
    try {
      assert.equal(resolveTernBinary(undefined), '/env/tern.com');
    } finally {
      if (prev === undefined) delete process.env.TERN_BIN;
      else process.env.TERN_BIN = prev;
    }
    if (process.platform === 'win32') {
      const conventional = resolveTernBinary(undefined);
      assert.ok(conventional.endsWith('tern.com') || conventional === 'tern', `got ${conventional}`);
    }
  });

  it('nodeTrampolineArgv emits node -e with one quoted static word', async () => {
    const { nodeTrampolineArgv } = await import('./tern.mjs');
    const hostile = ['C:\\Program Files\\x\\launch.mjs', '--agent', 'omp', '--', 'a"b', 'c$d', 'e`f', 'g!h', '100%', 'p&q', "it's"];
    // nodeTrampolineArgv encodes argv verbatim; runNode strips a leading
    // node exe before calling it (pane's own node spawns the child).
    const typed = nodeTrampolineArgv(hostile);
    assert.equal(typed[0], 'node');
    assert.equal(typed[1], '-e');
    const word = typed[2];
    // One double-quoted word: `tern run` joins words raw, so the script
    // must survive PowerShell/cmd/POSIX as a single argument.
    assert.ok(word.startsWith('"') && word.endsWith('"'), 'script word must be double-quoted');
    const script = word.slice(1, -1);
    assert.ok(!script.includes('"'), 'static script has no inner double quotes');
    const blob = script.match(/Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/)[1];
    assert.deepEqual(JSON.parse(Buffer.from(blob, 'base64').toString('utf8')), hostile);
  });
});

describe('cli plumbing', () => {
  // Captures what main writes through the streams it takes in deps. Never the process
  // streams: under `node --test` those carry the runner's own report.
  function captureIO() {
    const out = { stdout: '', stderr: '' };
    const sink = (key) => ({
      write(chunk) {
        out[key] += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      },
    });
    return { out, streams: { stdout: sink('stdout'), stderr: sink('stderr') }, restore() {} };
  }

  function fakeClient(impl) {
    return { requestCalls: [], async request(...args) { this.requestCalls.push(args); return impl(...args); } };
  }

  it('list with extra args is a usage error', async () => {
    const client = fakeClient(async () => ({}));
    await assert.rejects(main(['list', 'extra'], { client }), (err) => err?.code === 'usage');
    assert.equal(client.requestCalls.length, 0);
  });

  it('prompt --until without --wait is a usage error', async () => {
    const client = fakeClient(async () => ({}));
    await assert.rejects(
      main(['prompt', 'scout', 'hi', '--until', 'idle'], { client }),
      (err) => err?.code === 'usage',
    );
  });

  it('start without --pane is a usage error', async () => {
    const client = fakeClient(async () => ({}));
    await assert.rejects(main(['start', 'bot', '--kind', 'omp'], { client }), (err) => err?.code === 'usage');
  });

  it('start with unsupported kind emits a JSON error envelope, exit 1', async () => {
    const client = fakeClient(async () => ({}));
    const io = captureIO();
    try {
      const code = await main(['start', 'bot', '--kind', 'emacs', '--pane', '9'], { client, ...io.streams });
      assert.equal(code, 1);
      const envelope = JSON.parse(io.out.stderr.trim());
      assert.equal(envelope.error.code, 'unsupported_agent_kind');
      assert.equal(client.requestCalls.length, 0);
    } finally {
      io.restore();
    }
  });

  it('get forwards the target and wraps the bare agent in an envelope', async () => {
    const client = fakeClient(async (dir, method, params) => {
      assert.equal(method, 'get');
      return { name: params.target };
    });
    const io = captureIO();
    try {
      const code = await main(['get', 'scout', '--data-dir', '/d'], { client, ...io.streams });
      assert.equal(code, 0);
      const envelope = JSON.parse(io.out.stdout.trim());
      assert.equal(envelope.id, 'cli:agent:get');
      assert.equal(envelope.result.type, 'agent_info');
      assert.equal(envelope.result.agent.name, 'scout');
    } finally {
      io.restore();
    }
  });

  it('list wraps the bare array in an agent_list envelope', async () => {
    const client = fakeClient(async () => [{ name: 'scout' }]);
    const io = captureIO();
    try {
      const code = await main(['list', '--data-dir', '/d'], { client, ...io.streams });
      assert.equal(code, 0);
      const envelope = JSON.parse(io.out.stdout.trim());
      assert.equal(envelope.id, 'cli:agent:list');
      assert.equal(envelope.result.type, 'agent_list');
      assert.deepEqual(envelope.result.agents, [{ name: 'scout' }]);
    } finally {
      io.restore();
    }
  });

  it('read without --json prints text; with --json prints the full envelope', async () => {
    const payload = { type: 'pane_read', read: { text: 'hello pane', truncated: true, revision: 0 } };
    const client = fakeClient(async () => payload);
    const io = captureIO();
    try {
      assert.equal(await main(['read', 'scout'], { client, ...io.streams }), 0);
      assert.equal(io.out.stdout, 'hello pane\n');
    } finally {
      io.restore();
    }
    const io2 = captureIO();
    try {
      assert.equal(await main(['read', 'scout', '--json'], { client, ...io2.streams }), 0);
      const envelope = JSON.parse(io2.out.stdout.trim());
      assert.equal(envelope.result.read.truncated, true);
      assert.equal(envelope.result.read.revision, 0);
    } finally {
      io2.restore();
    }
    assert.deepEqual(client.requestCalls[0][2], { target: 'scout' });
  });

  it('ensure reports spawned:false only when the endpoint answers a live RPC', async () => {
    const client = fakeClient(async () => ({ type: 'agent_list', agents: [] }));
    const io = captureIO();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ensure-'));
    fs.writeFileSync(path.join(dir, 'endpoint.json'), JSON.stringify({ port: 9, token: 't' }));
    try {
      const code = await main(['ensure', '--data-dir', dir], {
        ...io.streams,
        client,
        spawnDaemon: () => { throw new Error('must not spawn'); },
      });
      assert.equal(code, 0);
      const envelope = JSON.parse(io.out.stdout.trim());
      assert.equal(envelope.result.spawned, false);
      assert.equal(client.requestCalls.length, 1);
      assert.equal(client.requestCalls[0][1], 'list');
    } finally {
      io.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ensure respawns when the endpoint file is stale', async () => {
    let calls = 0;
    const client = fakeClient(async (dir, method) => {
      calls++;
      if (calls === 1) throw new Error('connection refused');
      assert.equal(method, 'list');
      return { type: 'agent_list', agents: [] };
    });
    const io = captureIO();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stale-'));
    fs.writeFileSync(path.join(dir, 'endpoint.json'), JSON.stringify({ port: 9, token: 't' }));
    let spawned = 0;
    try {
      const code = await main(['ensure', '--data-dir', dir], {
        ...io.streams,
        client,
        spawnDaemon: () => {
          spawned++;
          return {};
        },
      });
      assert.equal(code, 0);
      assert.equal(spawned, 1);
      const envelope = JSON.parse(io.out.stdout.trim());
      assert.equal(envelope.result.spawned, true);
    } finally {
      io.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ensure waits for the fresh daemon when the stale file outlives the spawn', async () => {
    // Regression for the <=1s instant "timeout": after spawn the OLD endpoint
    // file still exists, so a single RPC fails against the dead daemon. The
    // CLI must keep polling a live RPC until the deadline, not fail on the
    // first refused connection.
    let calls = 0;
    const client = fakeClient(async () => {
      calls++;
      if (calls <= 3) throw new Error('connection refused');
      return { type: 'agent_list', agents: [] };
    });
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-replace-'));
    fs.writeFileSync(path.join(dir, 'endpoint.json'), JSON.stringify({ port: 9, token: 't' }));
    try {
      const code = await main(['ensure', '--data-dir', dir, '--timeout', '15000'], {
        client,
        stdout: { write: () => true },
        spawnDaemon: () => ({}),
      });
      assert.equal(code, 0);
      assert.ok(calls > 1, `must retry the live RPC, got ${calls} call(s)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

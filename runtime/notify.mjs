// runtime/notify.mjs — herdr's notification sounds, played by the daemon.
//
// herdr (src/app/actions.rs: notification_sound_for_state_change,
// record_or_deliver_agent_notification, agent_notification_delivery):
// - a new `blocked` earns `request`, whatever has focus;
// - a completion (working|blocked → idle) not seen by focus earns `done`;
// - nothing else chimes (first sightings, idle → working, unknown → idle);
// - every state change of a pane cancels its pending sound, and a sound is
//   delivered after 1 s (herdr's default `delay_seconds`) only if the pane still
//   has the same agent in the same state — focus is judged again then.
// So a question that lasts under a second, or a turn that restarts within it,
// never chimes. The daemon sees every transition (the rail's 250 ms poll can
// miss one), and it lives outside the window's 50 ms hooks, so the player it
// starts never costs the rail its timers.

const DELAY_MS = 1000;

export function createNotifier({
  state,
  play,
  muted = () => false,
  delayMs = DELAY_MS,
  setTimer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  const pending = new Map(); // pane -> {timer, kind, terminal_id, agent}
  const stats = { scheduled: 0, played: 0, dropped: 0 };

  function deliver(pane, p) {
    if (pending.get(pane) !== p) return;
    pending.delete(pane);
    const cur = state.peek(pane);
    const still =
      cur !== null &&
      cur.terminal_id === p.terminal_id &&
      cur.agent === p.agent &&
      (p.kind === "request" ? cur.agent_status === "blocked" : cur.agent_status === "done");
    if (!still || muted()) {
      stats.dropped += 1;
      return;
    }
    stats.played += 1;
    try {
      play(p.kind);
    } catch {
      // a missed sound, never a daemon error
    }
  }

  state.onTransition((t) => {
    const prior = pending.get(t.pane_id);
    if (prior) {
      clearTimer(prior.timer);
      pending.delete(t.pane_id);
    }
    let kind = null;
    if (t.next === "blocked" && t.prev !== "blocked") kind = "request";
    else if (t.completion && !t.seen) kind = "done";
    if (kind === null) return;
    const p = { kind, terminal_id: t.terminal_id, agent: t.agent, timer: null };
    p.timer = setTimer(() => deliver(t.pane_id, p), delayMs);
    pending.set(t.pane_id, p);
    stats.scheduled += 1;
  });

  return { stats, pending };
}

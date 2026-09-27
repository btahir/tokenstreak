// The goal-hit moment as one choreography across the canvas and the HUD.
//
//   T0 (celebration arrives, popover visible)
//   +0      the streak digit still shows yesterday's count; the hero counts up
//           (900 ms) with the pre-goal label, meta and bar
//   +920    the count lands on the goal: the label, meta and bar swap to "lit"
//           together with the ignition (shockwave, burst, sky flash), then the
//           roll call races back along the streak (Trail.celebrate)
//   +1050   the hero number springs to 1.07 and settles
//   +1200   the streak digit rolls from n-1 to n; the pill glints
//   +1300   a shimmer sweeps along the progress bar
//   +1600   the toast
//   +4700   the toast leaves; the celebration is acknowledged
//
// Reduced motion: no transforms; the Trail glows, the toast shows at once.
// DOM targets are found by role, so the views only need to mark nothing extra:
// `[data-testid=today-tokens]` / `.hero__num`, `[data-testid=streak-pill]`,
// `.progress`. Missing targets are skipped.

import { useEffect, useRef, useState, type RefObject } from "react";

export const GOAL_TIMELINE = { ignite: 920, hero: 1050, roll: 1200, glint: 1200, sweep: 1300, toast: 1600, done: 4700 } as const;

export interface GoalMomentInput {
  /** A pending celebration (streak including today). Null when there is none. */
  celebration: { date: string; streak: number; newRecord: boolean } | null;
  /** The surface is on screen (the popover is shown). */
  visible: boolean;
  reduced: boolean;
  root: RefObject<HTMLElement | null>;
  /** Closest ancestor of `root` to search for the progress bar (default: root). */
  scope?: string;
  /** Toast text for the moment (omit for no toast). */
  toastText?: (streak: number, newRecord: boolean) => string;
  /** Called when the moment ends (acknowledge it). */
  onDone?: () => void;
  /** Called at ignition (play a sound). */
  onIgnite?: (milestone: boolean) => void;
}

const MILESTONES = [7, 30, 100, 365];
const HERO = "[data-celebrate=hero], [data-testid=today-tokens], .hero__num";
const PILL = "[data-celebrate=streak], [data-testid=streak-pill]";
const PROGRESS = "[data-celebrate=progress], .progress";

function find(root: HTMLElement, sel: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(sel);
}

/** Shows `from` over the pill's digit, then rolls it up and the real digit in. */
function rollDigit(pill: HTMLElement, from: string, delay: number): () => void {
  const b = pill.querySelector<HTMLElement>("b");
  if (!b) return () => {};
  const cs = getComputedStyle(b);
  const old = document.createElement("span");
  old.className = "ts-roll-old";
  old.textContent = from;
  old.setAttribute("aria-hidden", "true");
  old.style.font = cs.font;
  old.style.letterSpacing = cs.letterSpacing;
  old.style.left = `${b.offsetLeft}px`;
  old.style.top = `${b.offsetTop}px`;
  old.style.height = `${b.offsetHeight}px`;
  old.style.lineHeight = cs.lineHeight;
  pill.classList.add("ts-rolling");
  pill.appendChild(old);
  const hide = b.animate([{ opacity: 0 }, { opacity: 0 }], { duration: delay, fill: "forwards" });
  const timers: number[] = [];
  timers.push(
    window.setTimeout(() => {
      hide.cancel();
      old.animate(
        [
          { transform: "translateY(0)", opacity: 1, filter: "blur(0)" },
          { transform: "translateY(-80%)", opacity: 0, filter: "blur(1.5px)" },
        ],
        { duration: 340, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" },
      );
      b.animate(
        [
          { transform: "translateY(85%)", opacity: 0, filter: "blur(1.5px)" },
          { transform: "translateY(-8%)", opacity: 1, filter: "blur(0)", offset: 0.7 },
          { transform: "translateY(0)", opacity: 1 },
        ],
        { duration: 560, easing: "cubic-bezier(0.22, 1, 0.36, 1)", delay: 90 },
      );
    }, delay),
  );
  timers.push(
    window.setTimeout(() => {
      old.remove();
      pill.classList.remove("ts-rolling");
    }, delay + 800),
  );
  return () => {
    timers.forEach(clearTimeout);
    hide.cancel();
    old.remove();
    pill.classList.remove("ts-rolling");
  };
}

function pulseClass(el: HTMLElement | null, cls: string, delay: number, dur: number, timers: number[]): void {
  if (!el) return;
  timers.push(
    window.setTimeout(() => {
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
    }, delay),
  );
  timers.push(window.setTimeout(() => el.classList.remove(cls), delay + dur));
}

/**
 * Runs the goal-hit choreography once per celebration while `visible`.
 * Returns the key that makes the Trail ignite, and the toast text.
 */
export function useGoalMoment(o: GoalMomentInput): { celebrateKey: number; toast: string | null } {
  const [celebrateKey, setKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const cb = useRef(o);
  cb.current = o;
  const c = o.celebration;
  useEffect(() => {
    if (!c || !o.visible) return;
    const root = o.root.current;
    const T = GOAL_TIMELINE;
    const timers: number[] = [];
    const cleanups: (() => void)[] = [];
    const milestone = MILESTONES.includes(c.streak);
    const at = (ms: number, f: () => void) => timers.push(window.setTimeout(f, ms));
    if (o.reduced) {
      at(0, () => {
        setKey((k) => k + 1);
        cb.current.onIgnite?.(milestone);
        if (cb.current.toastText) setToast(cb.current.toastText(c.streak, c.newRecord));
      });
      at(3200, () => {
        setToast(null);
        cb.current.onDone?.();
      });
    } else {
      const pill = root ? find(root, PILL) : null;
      if (pill && c.streak > 1) cleanups.push(rollDigit(pill, (c.streak - 1).toLocaleString("en-US"), T.roll));
      at(T.ignite, () => {
        setKey((k) => k + 1);
        cb.current.onIgnite?.(milestone);
      });
      at(T.hero, () => {
        const hero = root ? find(root, HERO) : null;
        if (!hero) return;
        hero.style.transformOrigin = "0% 85%";
        hero.animate(
          [
            { transform: "scale(1)" },
            { transform: "scale(1.07)", offset: 0.3 },
            { transform: "scale(0.992)", offset: 0.68 },
            { transform: "scale(1)" },
          ],
          { duration: 720, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      });
      pulseClass(pill, "ts-glint", T.glint, 1000, timers);
      const scope = root && o.scope ? (root.closest<HTMLElement>(o.scope) ?? root) : root;
      pulseClass(scope ? find(scope, PROGRESS) : null, "ts-sweep", T.sweep, 1100, timers);
      if (o.toastText) at(T.toast, () => setToast(cb.current.toastText!(c.streak, c.newRecord)));
      at(T.done, () => {
        setToast(null);
        cb.current.onDone?.();
      });
    }
    return () => {
      timers.forEach(clearTimeout);
      cleanups.forEach((f) => f());
    };
    // one run per celebration (by date) while visible
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.date, c?.streak, o.visible, o.reduced]);
  return { celebrateKey, toast };
}

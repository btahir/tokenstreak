// "Unlocked: …" toasts for achievements earned while the app is open.

import { useEffect } from "react";
import { BadgeArt } from "../../components/badges";
import { playCue } from "../../lib/sound";
import { getState, setState, useAppState } from "../../state/store";

export function UnlockToasts() {
  const queue = useAppState((s) => s.unlocked);
  const current = queue[0];
  useEffect(() => {
    if (!current) return;
    playCue("unlock");
    const t = setTimeout(() => setState({ unlocked: getState().unlocked.slice(1) }), 4200);
    return () => clearTimeout(t);
  }, [current]);
  if (!current) return null;
  return (
    <div className="unlock" role="status" key={current.id} data-testid="unlock-toast">
      <BadgeArt a={current} size={40} />
      <div>
        <div className="unlock__eyebrow">Unlocked</div>
        <div className="unlock__name">{current.title}</div>
      </div>
    </div>
  );
}

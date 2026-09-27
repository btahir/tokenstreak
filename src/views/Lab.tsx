// Mock-only design lab (?view=lab&theme=…): every Trail variant and every
// share card on one page, for side-by-side review. Not shipped in the app.

import { useEffect, useRef, useState } from "react";
import { loadPreset } from "../api/mock";
import type { AppSnapshot } from "../api/types";
import { buildTrailData } from "../lib/derive";
import { useResolvedTheme } from "../lib/theme";
import { buildCardModel, renderCard, type CardOptions } from "../share/cards";
import { TrailCanvas } from "../trail/TrailCanvas";

export function Lab() {
  const theme = useResolvedTheme();
  const [snaps, setSnaps] = useState<Record<string, AppSnapshot>>({});
  const only = new URLSearchParams(location.search).get("part") ?? "all";
  useEffect(() => {
    void Promise.all(["heavy-multi-tool", "streak-30", "streak-at-risk", "goal-hit", "long-history", "sparse"].map(async (id) => [id, (await loadPreset(id)).snapshot] as const)).then((xs) => setSnaps(Object.fromEntries(xs)));
  }, []);
  if (Object.keys(snaps).length < 6) return <div data-testid="lab-loading" />;
  return (
    <div className="lab" data-testid="lab">
      {(only === "all" || only === "trails") && (
        <>
          <div className="lab__row">
            {["heavy-multi-tool", "streak-30", "streak-at-risk", "goal-hit"].map((id) => (
              <div className="lab__pop" key={id}>
                <TrailCanvas data={buildTrailData(snaps[id]!, { maxDays: 42 })} theme={theme} variant="popover" ariaLabel={id} />
              </div>
            ))}
          </div>
          <div className="lab__full">
            <TrailCanvas data={buildTrailData(snaps["heavy-multi-tool"]!, { maxDays: 365 })} theme={theme} variant="full" layout={{ maxDays: 365 }} ariaLabel="full" />
          </div>
          <div className="lab__full">
            <TrailCanvas data={buildTrailData(snaps["streak-30"]!, { maxDays: 120 })} theme={theme} variant="full" layout={{ maxDays: 120 }} ariaLabel="full" />
          </div>
          <div className="lab__full">
            <TrailCanvas data={buildTrailData(snaps["long-history"]!, { maxDays: 2000 })} theme={theme} variant="full" layout={{ maxDays: 2000 }} ariaLabel="long history, all" />
          </div>
          <div className="lab__full">
            <TrailCanvas data={buildTrailData(snaps["sparse"]!, { maxDays: 365 })} theme={theme} variant="full" layout={{ maxDays: 365 }} ariaLabel="sparse" />
          </div>
        </>
      )}
      {(only === "all" || only === "cards") && (
        <div className="lab__cards">
          {(["streak", "year", "lean"] as const).flatMap((template) =>
            (["square", "story"] as const).map((format) => <Card key={template + format} snap={snaps["heavy-multi-tool"]!} o={{ template, format, theme, showMix: true, showCost: false, showProjects: false }} />),
          )}
        </div>
      )}
    </div>
  );
}

function Card({ snap, o }: { snap: AppSnapshot; o: CardOptions }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void renderCard(buildCardModel(snap, o, null), o).then((c) => {
      c.style.width = o.format === "story" ? "270px" : "360px";
      host.current?.replaceChildren(c);
    });
  }, [snap, o.template, o.format, o.theme]);
  return <div ref={host} className="lab__card" />;
}

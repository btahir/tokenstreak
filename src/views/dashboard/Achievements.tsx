// All achievements: badge art, unlock dates, and progress toward the rest.

import { useEffect, useMemo, useState } from "react";
import type { Achievement, AchievementCategory, AppSnapshot } from "../../api/types";
import { Badge, BadgeArt, CATEGORY_LABEL, TIER_CLASS, TIER_LABEL } from "../../components/badges";
import { Progress, Seg } from "../../components/ui";
import { formatDate, formatInt, formatTokens } from "../../lib/format";
import { useApi } from "../../state/store";
import { PageHead } from "./PageHead";

type Filter = "all" | AchievementCategory;

export function progressText(a: Achievement): string {
  const left = Math.max(0, a.target - a.progress);
  if (a.unlockedAt) return `Unlocked ${formatDate(a.unlockedAt)}`;
  if (a.progress <= 0) return a.description;
  if (a.category === "streak" && a.target > 1) return `${formatInt(Math.ceil(left))} ${Math.ceil(left) === 1 ? "day" : "days"} to go`;
  if (a.target >= 1000) return `${formatTokens(a.progress)} of ${formatTokens(a.target)}`;
  if (a.target < 1) return `Best so far ${Math.round(a.progress * 100)}% of ${Math.round(a.target * 100)}%`;
  if (a.target > 1 && !Number.isInteger(a.progress) && a.target <= 10) return `Best ${a.progress.toFixed(1)}× of ${formatInt(a.target)}×`;
  if (a.target > 1) return `${formatInt(a.progress)} of ${formatInt(a.target)}`;
  return a.description;
}

export function Achievements({ snap }: { snap: AppSnapshot }) {
  const api = useApi();
  const [filter, setFilter] = useState<Filter>("all");
  const all = snap.achievements;
  const unlocked = all.filter((a) => a.unlockedAt).length;
  const cats = useMemo(() => Array.from(new Set(all.map((a) => a.category))), [all]);
  const list = filter === "all" ? all : all.filter((a) => a.category === filter);
  const next = all.filter((a) => !a.unlockedAt && a.progress > 0).sort((a, b) => b.progress / (b.target || 1) - a.progress / (a.target || 1))[0];

  // Seeing a new badge acknowledges it (after its shine has played).
  const newIds = all.filter((a) => a.isNew).map((a) => a.id).join(",");
  useEffect(() => {
    if (!api || !newIds) return;
    const t = setTimeout(() => void api.acknowledgeAchievements(newIds.split(",")), 4000);
    return () => clearTimeout(t);
  }, [api, newIds]);

  return (
    <div className="page" data-testid="page-achievements">
      <PageHead
        eyebrow={`${unlocked} of ${all.length} unlocked`}
        title="Achievements"
        actions={
          <Seg
            label="Category"
            value={filter}
            onChange={setFilter}
            options={[{ value: "all" as Filter, label: "All" }, ...cats.map((c) => ({ value: c as Filter, label: CATEGORY_LABEL[c] }))]}
          />
        }
      />
      {next && (
        <section className="card next" data-testid="almost-there">
          <div className="badge badge--locked next__art">
            <div className="badge__art">
              <BadgeArt a={next} size={84} />
            </div>
          </div>
          <div className="next__body">
            <div className="eyebrow">Almost there</div>
            <div className="next__title">{next.title}</div>
            <div className="ts-label">
              {next.description} {progressText(next)}.
            </div>
            <Progress value={next.progress / (next.target || 1)} className="next__bar" label={`${next.title} progress`} />
          </div>
          <span className={`rarity rarity--${TIER_CLASS[next.tier]}`}>
            {TIER_LABEL[next.tier]} · {CATEGORY_LABEL[next.category].toLowerCase()}
          </span>
        </section>
      )}
      <section className="card">
        <div className="agrid" data-testid="achievement-grid">
          {list.map((a) => (
            <Badge key={a.id} a={a} size={88} meta={progressText(a)} />
          ))}
        </div>
      </section>
      <p className="note note--center">No achievement is ever based on money spent. Streak badges are earned by showing up; craft badges by working well.</p>
    </div>
  );
}

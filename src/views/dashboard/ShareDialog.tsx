// Share dialog: live preview of the card and the options that shape it, then
// Copy image or Save PNG (through api.saveExport). Rendered on this Mac.

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSnapshot, ShareCardData } from "../../api/types";
import { IconClose, IconCopy, IconDownload } from "../../components/icons";
import { Seg, Toggle } from "../../components/ui";
import { formatInt, formatUsd } from "../../lib/format";
import { buildCardModel, canvasToBase64, CARD_SIZE, cardFileName, copyCanvas, leanestWeek, renderCard, type CardOptions } from "../../share/cards";
import { useApi, useSettings } from "../../state/store";

export function ShareDialog({ snap, onClose }: { snap: AppSnapshot; onClose: () => void }) {
  const api = useApi();
  const settings = useSettings();
  const [o, setO] = useState<CardOptions>(() => ({
    template: "streak",
    format: "square",
    // Dusk cards are the most shareable, so dark is the default (?card=light for screenshots).
    theme: new URLSearchParams(location.search).get("card") === "light" ? "light" : "dark",
    showMix: settings?.share.showAgentMix ?? true,
    showCost: settings?.share.showCost ?? false,
    showProjects: settings?.share.showProjectNames ?? false,
  }));
  const [share, setShare] = useState<ShareCardData | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!api) return;
    void api.getShareCard({ range: { kind: "last30" }, format: o.format, includeProjectNames: o.showProjects }).then(setShare);
  }, [api, o.format, o.showProjects]);

  const model = useMemo(() => buildCardModel(snap, o, share), [snap, o, share]);

  useEffect(() => {
    let live = true;
    void renderCard(model, o).then((c) => {
      if (!live) return;
      c.className = "share__canvas";
      c.setAttribute("role", "img");
      c.setAttribute("aria-label", `${model.headline} ${model.subline}`);
      c.dataset.testid = "share-canvas";
      setCanvas(c);
    });
    return () => {
      live = false;
    };
  }, [model, o]);

  useEffect(() => {
    const h = host.current;
    if (!h || !canvas) return;
    h.replaceChildren(canvas);
  }, [canvas]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      // keep Tab inside the dialog
      const d = dialog.current;
      if (e.key !== "Tab" || !d) return;
      const f = [...d.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, [tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === d)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !d.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const flash = (s: string) => {
    setStatus(s);
    setTimeout(() => setStatus(null), 3200);
  };
  const save = async () => {
    if (!api || !canvas) return;
    setBusy(true);
    try {
      const path = await api.saveExport(cardFileName(o), canvasToBase64(canvas));
      flash(`Saved to ${path.replace(/^\/Users\/[^/]+/, "~")}`);
    } catch (e) {
      flash(`Couldn’t save: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!canvas) return;
    const ok = await copyCanvas(canvas);
    flash(ok ? "Copied. Paste it anywhere." : "Copy isn’t available here. Use Save PNG.");
  };
  const size = CARD_SIZE[o.format];
  const lean = useMemo(() => leanestWeek(snap.days, snap.today.date), [snap]);
  const set = <K extends keyof CardOptions>(k: K, v: CardOptions[K]) => setO((p) => ({ ...p, [k]: v }));

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid="share-dialog">
      <div className={`dialog dialog--${o.format}`} role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1} ref={dialog}>
        <div className="dialog__prev">
          <div className="share__frame" ref={host} />
        </div>
        <div className="dialog__ctl">
          <button type="button" className="dialog__close" aria-label="Close" onClick={onClose}>
            <IconClose />
          </button>
          <div>
            <div className="eyebrow">Share card</div>
            <h2 id="share-title" className="dialog__title">
              Show off your light
            </h2>
          </div>
          <div>
            <div className="ts-label dialog__lab">Template</div>
            <div className="tpls" role="radiogroup" aria-label="Template">
              {(
                [
                  ["streak", snap.streak.current || snap.streak.longest ? `${formatInt(snap.streak.current || snap.streak.longest)} days` : "Day one", snap.streak.current ? "Streak" : "Best run"],
                  ["year", "365 days", "My year in light"],
                  ["lean", lean ? (o.showCost ? formatUsd(lean.perM) : `${Math.round(Math.max(0, -lean.vsUsual) * 100)}% leaner`) : "—", "Leanest week"],
                ] as const
              ).map(([k, big, lab]) => (
                <button key={k} type="button" role="radio" aria-checked={o.template === k} className={`tpl${o.template === k ? " on" : ""}`} onClick={() => set("template", k)}>
                  <b>{big}</b>
                  {lab}
                </button>
              ))}
            </div>
          </div>
          <div className="opt">
            <span>Format</span>
            <Seg
              label="Format"
              value={o.format}
              onChange={(v) => set("format", v)}
              options={[
                { value: "square", label: "Square 1:1" },
                { value: "story", label: "Story 9:16" },
              ]}
            />
          </div>
          <div className="opt">
            <span>Theme</span>
            <Seg
              label="Card theme"
              value={o.theme}
              onChange={(v) => set("theme", v)}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </div>
          <div className="opt">
            <span>Agent mix</span>
            <Toggle label="Agent mix" on={o.showMix} onChange={(v) => set("showMix", v)} />
          </div>
          <div className="opt">
            <span>Estimated cost</span>
            <Toggle label="Estimated cost" on={o.showCost} onChange={(v) => set("showCost", v)} />
          </div>
          <div className="opt">
            <span>
              Project names <span className="lock">· private by default</span>
            </span>
            <Toggle label="Project names" on={o.showProjects} onChange={(v) => set("showProjects", v)} />
          </div>
          <div className="dialog__actions">
            <button type="button" className="btn btn--lg" onClick={() => void copy()} disabled={!canvas} data-testid="share-copy">
              <IconCopy /> Copy image
            </button>
            <button type="button" className="btn btn--glow btn--lg" onClick={() => void save()} disabled={!canvas || busy} data-testid="share-save">
              <IconDownload /> Save PNG · {size.w} × {size.h}
            </button>
          </div>
          <div className="ts-label dialog__foot" role="status">
            {status ?? "Rendered on this Mac. Nothing is uploaded."}
          </div>
        </div>
      </div>
    </div>
  );
}

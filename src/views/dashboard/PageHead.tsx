import type { ReactNode } from "react";

export function PageHead({ eyebrow, title, actions }: { eyebrow: ReactNode; title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="top">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      {actions && <div className="top__actions">{actions}</div>}
    </header>
  );
}

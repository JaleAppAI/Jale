import * as React from "react";

export function Card({
  className = "",
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={[
        "rounded-[var(--radius-card)] bg-[var(--jale-card)]",
        "shadow-[var(--shadow-card)]",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}

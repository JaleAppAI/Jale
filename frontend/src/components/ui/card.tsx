import * as React from "react";

export function Card({
  className = "",
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={[
        "rounded-[14px] md:rounded-[var(--radius-card)]",
        "border border-border/60 bg-card",
        "shadow-[var(--shadow-card)]",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}

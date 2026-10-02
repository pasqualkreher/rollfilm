// The app's one busy indicator: a ring with a turning head. Everything that
// spins is this component, so a wait looks and moves the same wherever it
// shows (index.css, ".spinner").
//
//   size  sm 12px - inside a pill or badge
//         md 14px - beside a line of text, in a button (default)
//         lg 22px - on its own, in the wait popup
//   tone  accent  - the accent colour on the app's own surfaces (default)
//         inherit - the colour of the text it sits in: on a filled button, on
//                   the dark stage and its badges
//   inline        - set into running text or a button label: keeps the gap to
//                   the words after it
export function Spinner({
  size = "md",
  tone = "accent",
  inline = false,
}: {
  size?: "sm" | "md" | "lg";
  tone?: "accent" | "inherit";
  inline?: boolean;
}) {
  const classes = ["spinner"];
  if (size !== "md") classes.push(`spinner--${size}`);
  if (tone === "inherit") classes.push("spinner--inherit");
  if (inline) classes.push("spinner--inline");
  return <span className={classes.join(" ")} aria-hidden="true" />;
}

// A page or panel whose content is still being fetched: the spinner and a
// word, where the content will be. Held back a moment (index.css,
// ".loading-state") so a fetch that lands at once never flashes it.
export function LoadingState({ label = "Loading…", className = "" }: { label?: string; className?: string }) {
  return (
    <div className={`${className} empty-state loading-state`.trim()} role="status">
      <Spinner />
      {label}
    </div>
  );
}

import { IconX } from "./Icons";

export interface BarMessage {
  text: string;
  error?: boolean;
}

// The bulk bar's status line: what the last action did, or why it failed. It
// rides on top of the bar rather than taking a row inside it (see
// .action-bar-messages), and the × takes it away - a failure stays until then
// or until the next action, instead of timing out unread.
export function ActionBarMessages({
  messages,
  onDismiss,
}: {
  messages: Array<BarMessage | null | undefined>;
  onDismiss: () => void;
}) {
  const shown = messages.filter((m): m is BarMessage => Boolean(m?.text));
  if (shown.length === 0) return null;
  return (
    <div className="action-bar-messages" role="status">
      <div className="action-bar-messages-list">
        {shown.map((m) => (
          <span key={m.text} className={m.error ? "action-bar-message--error" : undefined}>
            {m.text}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="action-bar-messages-close"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss the message"
      >
        <IconX size={12} />
      </button>
    </div>
  );
}

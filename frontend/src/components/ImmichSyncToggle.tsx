import { IconCheck, IconCloudUp } from "./Icons";

// The selective-sync switch as a button, so it lines up with "Add to Immich"
// in manual mode instead of a bare checkbox next to buttons. Pressed state
// shows the tick; the cloud stays either way so the row reads the same in
// both sync modes.
export function ImmichSyncToggle({
  on,
  onToggle,
  disabled = false,
  small = false,
  title,
  label = "Sync to Immich",
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  disabled?: boolean;
  small?: boolean;
  title: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      className={`btn immich-sync-toggle${small ? " btn-sm" : ""}`}
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={() => onToggle(!on)}
    >
      <IconCloudUp size={small ? 12 : 13} /> {label}
      {on && <IconCheck size={small ? 12 : 13} className="immich-sync-toggle-check" />}
    </button>
  );
}

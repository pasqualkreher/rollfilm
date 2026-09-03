// Shared inline SVG icon set for the app chrome. Stroke-based, 1.5px weight,
// currentColor - so icons inherit text colour and render crisply at any DPI,
// unlike the unicode/emoji glyphs they replaced (whose weight and metrics vary
// by platform font and made the chrome look uneven).

interface IconProps {
  size?: number;
  className?: string;
}

function svgProps({ size = 16, className }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: className ? `icon ${className}` : "icon",
    "aria-hidden": true as const,
  };
}

export function IconX(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 2.5v11M2.5 8h11" />
    </svg>
  );
}

export function IconMinus(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 8h11" />
    </svg>
  );
}

// Three bars - the collapsed navigation menu.
export function IconMenu(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

// A tabbed folder - one directory in the picker list.
export function IconFolder(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.75 12.25v-8.5a1 1 0 0 1 1-1h3.4l1.5 1.75h5.6a1 1 0 0 1 1 1v6.75a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function IconArrowUp(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 13.5v-11M3.5 7 8 2.5 12.5 7" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3 8.5l3.5 3.5L13 4.5" />
    </svg>
  );
}

// The two overlapping L-arms of a crop tool: an arm along the top-left corner
// and one along the bottom-right, each running past the other.
export function IconCrop(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4.5 1.5v10h10M1.5 4.5h10v10" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3.5 6l4.5 4.5L12.5 6" />
    </svg>
  );
}

// Drawn symmetrically about the middle of the 16px box (x 5.75-10.25,
// y 3.5-12.5) so they sit dead centre in a round button. The "‹" and "›"
// characters these replaced carry their own uneven side bearings, which is
// exactly what made the lightbox arrows look off-centre.
export function IconChevronLeft(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M10.25 3.5L5.75 8l4.5 4.5" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M5.75 3.5L10.25 8l-4.5 4.5" />
    </svg>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M13.5 8h-11M7 3.5L2.5 8 7 12.5" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.3 10.3l3.2 3.2" />
    </svg>
  );
}

export function IconRotate(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 1.5v3h-3" />
    </svg>
  );
}

// Flip horizontal / vertical: two arrowheads pointing away from a dashed
// mirror axis. Same pair rotated a quarter turn, so the two read as one set.
export function IconFlipH(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 1.5v13" strokeDasharray="2 2" />
      <path d="M6 4.5 2.5 8 6 11.5" />
      <path d="M10 4.5 13.5 8 10 11.5" />
    </svg>
  );
}

export function IconFlipV(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.5 8h13" strokeDasharray="2 2" />
      <path d="M4.5 6 8 2.5 11.5 6" />
      <path d="M4.5 10 8 13.5 11.5 10" />
    </svg>
  );
}

// Targeted adjustment (the curve picker): a crosshair over a target, with the
// up/down arrows that say the gesture is a vertical drag.
export function IconTarget(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="3.2" />
      <path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15" />
    </svg>
  );
}

export function IconStar({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  const p = svgProps(props);
  return (
    <svg {...p} fill={filled ? "currentColor" : "none"}>
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6L8 1.8z" />
    </svg>
  );
}

export function IconFilter(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.5 3h13L9.75 8.6v4.4l-3.5 1.5V8.6L1.5 3z" />
    </svg>
  );
}

// The two compare modes, drawn as what they do to the frame.
// Split: one picture cut down the middle by the divider you drag - the left
// half hatched to say "this side is the other version".
export function IconSplit(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1" />
      <path d="M8 3.25v9.5" />
      <path d="M3 6.5l3-3M3 9.5l4.5-4.5M3.5 12l4-4" strokeWidth={1} />
    </svg>
  );
}

// Side by side: two whole pictures, one per version.
export function IconSideBySide(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1" y="3.75" width="6" height="8.5" rx="1" />
      <rect x="9" y="3.75" width="6" height="8.5" rx="1" />
    </svg>
  );
}

// A drawing pin seen from the side: head, shaft, point. `filled` is the
// "pinned" state - the same shape solid, so the on/off reads at 13px.
export function IconPin({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...svgProps(props)} fill={filled ? "currentColor" : "none"}>
      <path d="M6 1.75h4l-.6 3.4 2.35 2.6H4.25L6.6 5.15 6 1.75z" />
      <path d="M8 7.75v6.5" fill="none" />
    </svg>
  );
}

// Statistics tiles: a picture, a camera body, a lens (aperture blades) and a
// stack of platters for the library's size on disk.
export function IconImage(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.75" y="3" width="12.5" height="10" rx="1.75" />
      <circle cx="5.6" cy="6.4" r="1" />
      <path d="M2.25 11.25l3.4-3.1 2.5 2.25 2.4-2.4 3.2 3.2" />
    </svg>
  );
}

export function IconCamera(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.75" y="4.5" width="12.5" height="9" rx="1.75" />
      <path d="M5.6 4.5l.9-1.75h3l.9 1.75" />
      <circle cx="8" cy="9" r="2.6" />
    </svg>
  );
}

export function IconAperture(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 1.75v5.4M13.45 11.1L8.75 8.4M2.55 11.1l4.7-2.7" />
    </svg>
  );
}

export function IconDisk(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <ellipse cx="8" cy="4" rx="5.25" ry="2.25" />
      <path d="M2.75 4v8c0 1.25 2.35 2.25 5.25 2.25s5.25-1 5.25-2.25V4" />
      <path d="M2.75 8c0 1.25 2.35 2.25 5.25 2.25S13.25 9.25 13.25 8" />
    </svg>
  );
}

export function IconChart(props: IconProps) {
  // Three rising bars on a baseline - the stats dashboard.
  return (
    <svg {...svgProps(props)}>
      <path d="M2 13.5h12" />
      <path d="M4 13.5V9.5M8 13.5V5.5M12 13.5V2.5" />
    </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 4.25h11M6.25 2.25h3.5M4 4.25l.7 9a1.25 1.25 0 001.25 1.15h4.1a1.25 1.25 0 001.25-1.15l.7-9" />
      <path d="M6.5 7v4.5M9.5 7v4.5" />
    </svg>
  );
}

export function IconEye(props: IconProps) {
  // Hold-to-compare: "look at the baseline".
  return (
    <svg {...svgProps(props)}>
      <path d="M1.75 8S4.25 3.9 8 3.9 14.25 8 14.25 8 11.75 12.1 8 12.1 1.75 8 1.75 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  );
}

// The same eye struck through - this layer/mask is hidden.
export function IconEyeOff(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.75 8S4.25 3.9 8 3.9 14.25 8 14.25 8 11.75 12.1 8 12.1 1.75 8 1.75 8z" opacity="0.45" />
      <path d="M2.75 13.25l10.5-10.5" />
    </svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.2v4" />
      <circle cx="8" cy="4.9" r="0.55" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconPencil(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M11.1 2.4a1.35 1.35 0 0 1 1.9 1.9l-7.3 7.3-2.5.6.6-2.5 7.3-7.3z" />
      <path d="M10.1 3.4l1.9 1.9" />
    </svg>
  );
}

export function IconGear(props: IconProps) {
  // A real cog with teeth (Bootstrap Icons "gear", MIT) - the spoke-based
  // version read as a brightness/sun icon. Filled outline, not stroked.
  return (
    <svg {...svgProps(props)} fill="currentColor" stroke="none">
      <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z" />
      <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z" />
    </svg>
  );
}

export function IconHelp(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.2 6.2a1.8 1.8 0 1 1 2.6 1.6c-.5.3-.8.6-.8 1.2v.3" />
      <circle cx="8" cy="11.4" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconMail(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1.5" />
      <path d="M2.6 4.9 8 8.9l5.4-4" />
    </svg>
  );
}

// Undo / redo: an arrow curving back over itself onto a hook, mirrored for the
// other direction - the pair reads as one gesture and its reverse.
export function IconUndo(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7H6" />
      <path d="M5.5 3.5 2.5 6.5l3 3" />
    </svg>
  );
}

export function IconRedo(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H10" />
      <path d="m10.5 3.5 3 3-3 3" />
    </svg>
  );
}

// Text alignment. The horizontal four are lines of text ragged on one side or
// the other; the vertical three are the same lines pinned to one edge of the
// box, with that edge drawn.
export function IconAlignLeft(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7" />
    </svg>
  );
}

export function IconAlignCenter(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7" />
    </svg>
  );
}

export function IconAlignRight(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7" />
    </svg>
  );
}

export function IconAlignJustify(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h11" />
    </svg>
  );
}

export function IconAlignTop(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 2.5h11" />
      <path d="M4.5 6h7M4.5 9h7" />
    </svg>
  );
}

export function IconAlignMiddle(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 2.5h11M2.5 13.5h11" opacity="0.45" />
      <path d="M4.5 6.5h7M4.5 9.5h7" />
    </svg>
  );
}

export function IconAlignBottom(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 13.5h11" />
      <path d="M4.5 7h7M4.5 10h7" />
    </svg>
  );
}

// A padlock, closed and open: whether two values are tied together.
export function IconLock(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="3.5" y="7.5" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function IconLockOpen(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="3.5" y="7.5" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 4.8-1" />
    </svg>
  );
}

// Two sheets, one behind the other: make a copy of this.
export function IconDuplicate(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

// A "T" - text placed on the page.
export function IconTextT(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3.5 4.5V3h9v1.5M8 3v10M6.5 13h3" />
    </svg>
  );
}

// A horseshoe magnet - snapping.
export function IconMagnet(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M5.2 2.5v5.3a2.8 2.8 0 0 0 5.6 0V2.5" />
      <path d="M3.9 5.2h2.6M9.5 5.2h2.6" />
    </svg>
  );
}

// A 3x3 measuring grid.
export function IconGrid(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M2.5 6.17h11M2.5 9.83h11M6.17 2.5v11M9.83 2.5v11" />
    </svg>
  );
}

// Two offset sheets - the paged canvas.
export function IconSheets(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M5.5 4.5h7v9h-7z" />
      <path d="M3.5 11.5v-9h7" />
    </svg>
  );
}

// A lemniscate - the free (endless) canvas.
export function IconInfinity(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M5 10.5C3.2 10.5 2 9.4 2 8s1.2-2.5 3-2.5c2.6 0 5.4 5 8 5 1.8 0 3-1.1 3-2.5s-1.2-2.5-3-2.5c-2.6 0-5.4 5-8 5Z" />
    </svg>
  );
}

// A dashed sheet outline - the page guide on the free canvas.
export function IconGuide(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" strokeDasharray="2.6 2.2" />
    </svg>
  );
}

// Corner brackets closing in - fit one page in the window.
export function IconFitPage(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M13.5 5.5v-2a1 1 0 0 0-1-1h-2M2.5 10.5v2a1 1 0 0 0 1 1h2M13.5 10.5v2a1 1 0 0 1-1 1h-2" />
      <rect x="6" y="6.4" width="4" height="3.2" rx="0.6" />
    </svg>
  );
}

// Four sheets at once - fit the whole layout.
export function IconFitAll(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="0.8" />
      <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="0.8" />
      <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="0.8" />
      <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="0.8" />
    </svg>
  );
}

// A printer - the print view.
export function IconPrinter(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4.5 6V2.5h7V6" />
      <path d="M4.5 11H3.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1" />
      <path d="M4.5 9.5h7v4h-7z" />
    </svg>
  );
}

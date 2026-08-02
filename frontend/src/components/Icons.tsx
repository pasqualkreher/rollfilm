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

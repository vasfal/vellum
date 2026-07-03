"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

// The leading "#" grid glyph, split out from the wordmark so it can spin on its
// own. Its hole (inner square) is the trailing subpath, kept in the same winding
// order as the original combined path so it still renders as a cut-out.
const GLYPH_D =
  "M6.50391 3.5H9.50391V1H12.5039V3.5H15.0039V6.5H12.5039V9.5H15.0039V12.5H12.5039V15H9.50391V12.5H6.50391V15H3.50391V12.5H1.00391V9.5H3.50391V6.5H1.00391V3.5H3.50391V1H6.50391V3.5ZM6.50391 9.5H9.50391V6.5H6.50391V9.5Z";

// The "VELLUM" letters — static.
const TEXT_D =
  "M86.7959 7.94043C86.7959 9.45243 87.2643 11.4512 90.4863 11.4512H90.5762C93.78 11.4511 94.2119 9.4524 94.2119 7.94043V1.40723H98.4961V7.99512C98.496 10.6591 97.6497 14.9971 90.792 14.9971H90.2695C83.1422 14.9969 82.5118 10.6411 82.5117 7.99512V1.40723H86.7959V7.94043ZM27.3057 10.9473L31.5176 1.40723H36.0898L29.9697 14.7988H24.498L18.1084 1.40723H23.0938L27.3057 10.9473ZM50.6113 4.48438H42.043V6.42871H50.3418V9.61523H42.043V11.6846H50.7197V14.7988H37.7773V1.40723H50.6113V4.48438ZM57.8643 11.3066H65.9648V14.7988H53.5625V1.40723H57.8643V11.3066ZM72.7354 11.3066H80.8359V14.7988H68.4336V1.40723H72.7354V11.3066ZM111.343 9.74121L115.374 1.40723H120.918V14.7988H116.706V6.24902L112.692 14.7988H109.704L105.708 6.24902V14.7988H101.568V1.40723H107.4L111.343 9.74121Z";

// The Vellum wordmark (grid glyph + type). currentColor → foreground so it renders
// on any surface and tracks the theme. Defined once and reused everywhere the
// brand appears (sidebar, workspace gate screens). Sized by height via className;
// width is auto from the 122×16 viewBox.
//
// The grid glyph turns a quarter (90°) each time the pointer enters AND each time
// it leaves — always in the SAME direction, so it keeps advancing forward and
// never snaps back to where it came from (a # reads identical every 90°, so it
// just looks like it's turning onward). It pivots on its own centre
// (transform-box: fill-box). Stilled under prefers-reduced-motion (ADR-005).
export function Logo({ className }: { className?: string }) {
  const [rotation, setRotation] = useState(0);
  const advance = () => setRotation((r) => r + 90);

  return (
    <svg
      viewBox="0 0 122 16"
      className={cn("h-4 w-auto text-foreground", className)}
      fill="currentColor"
      role="img"
      aria-label="Vellum"
      xmlns="http://www.w3.org/2000/svg"
      onMouseEnter={advance}
      onMouseLeave={advance}
    >
      <g
        className="origin-center transition-transform duration-500 ease-out motion-reduce:transition-none"
        style={{ transformBox: "fill-box", transform: `rotate(${rotation}deg)` }}
      >
        <path d={GLYPH_D} />
      </g>
      <path d={TEXT_D} />
    </svg>
  );
}

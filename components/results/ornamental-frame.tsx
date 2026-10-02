"use client";

/**
 * OrnamentalFrame — the four-sided ornamental border of the Statement of Marks.
 *
 * ## The supplied asset
 *
 * `public/border.png` is the ONLY ornament used. It is never modified: every
 * side of the frame is produced by cropping, tiling and reflecting that one
 * file at render time.
 *
 * Measured contents of the asset (see the implementation notes in the repo):
 *
 *   canvas ............ 512 x 512
 *   artwork ........... a single HORIZONTAL strip:
 *                       rows 246-266 (21 px tall), columns 16-495 (480 px wide)
 *                       everything else is flat white
 *   horizontal period . 28 px (mirror-symmetry axes every 14 px)
 *   edges ............. the strip is cut flush at both ends, so it is a
 *                       repeating frieze, not a corner piece
 *
 * ## How one side becomes four
 *
 * 1. `background`/`<image>` cropping — the strip is shown through a
 *    `<pattern>` tile that is exactly ONE period wide (28 px) and exactly the
 *    strip height (20 px). The `<image>` inside the tile is offset by
 *    (-45, -246) so the tile lands on a mirror axis and shows only the strip.
 * 2. `background-repeat` — the tile is repeated by the SVG pattern, so the
 *    ornament runs the full length of the side at 1:1 with no stretching.
 * 3. rotation / reflection — the same tile is re-used for the other sides:
 *
 *    | side   | orientation                |
 *    | ------ | -------------------------- |
 *    | top    | as supplied                |
 *    | bottom | `scaleY(-1)`               |
 *    | left   | `patternTransform="rotate(-90)"` |
 *    | right  | `patternTransform="rotate(90)"`  |
 *
 *    The strip's structured edge (its two solid rule lines) always ends up on
 *    the INSIDE of the frame, so those rules join up into one unbroken
 *    rectangular keyline around the content while the filigree faces outwards.
 *
 * 4. corners — the top/bottom bands span the full document width and the
 *    left/right bands the full height, so they overlap in four 20 x 20 px
 *    squares (see `ornamental-frame.module.css`, where the horizontal bands
 *    sit above the vertical ones). There are no gaps, no white wedges and no
 *    stretched corner pixels: the corner square is filled by a genuine,
 *    undistorted piece of the supplied ornament, and the inner keyline closes
 *    the rectangle exactly.
 *
 * Because the pattern is expressed in CSS pixels (the `<svg>` has no
 * `viewBox`), the ornament is always rendered at 1:1 regardless of how long a
 * side is — only the amount of repetition changes.
 */

import type { CSSProperties, ReactNode } from "react";
import { useId } from "react";
import styles from "./ornamental-frame.module.css";

/* ── Measured geometry of the supplied asset ─────────────────────── */

/** Width/height of the supplied canvas. */
const SOURCE_SIZE = 512;
/** First row of the ornamental strip inside the canvas. */
const SOURCE_BAND_TOP = 246;
/**
 * Height of the ornamental strip (also the frame thickness).
 *
 * The artwork was measured pixel-by-pixel: the frieze occupies rows 246–266
 * inclusive (row 266 still carries ~469 lit pixels of its own soft edge, while
 * rows 240–245 and 267–271 only hold stray JPEG speckles). The band therefore
 * has to be 21px tall — cropping it to 20px would slice off that bottom edge
 * and produce a hard seam that is not in the source.
 */
const SOURCE_BAND_HEIGHT = 21;
/** Column of the chosen repeating unit (a mirror axis of the ornament). */
const SOURCE_TILE_LEFT = 45;
/** Fundamental horizontal period of the ornament. */
const SOURCE_PERIOD = 28;

/** Path of the untouched source ornament. */
const BORDER_SRC = "/border.png";

/**
 * Rendered frame thickness in CSS px.
 *
 * Equal to the strip height in the asset, so the ornament is drawn 1:1 and is
 * never resampled or distorted. Change this together with `--msu-band` in the
 * stylesheet to scale the whole frame uniformly.
 */
const BAND = SOURCE_BAND_HEIGHT;

/** Uniform render scale, derived from the requested thickness. */
const SCALE = BAND / SOURCE_BAND_HEIGHT;

const TILE_WIDTH = SOURCE_PERIOD * SCALE;
const TILE_HEIGHT = SOURCE_BAND_HEIGHT * SCALE;
const IMAGE_X = -SOURCE_TILE_LEFT * SCALE;
const IMAGE_Y = -SOURCE_BAND_TOP * SCALE;
const IMAGE_SIZE = SOURCE_SIZE * SCALE;

type EdgeVariant = "top" | "bottom" | "left" | "right";

/** Rotation applied to the tile so the ornament follows a vertical edge. */
function patternRotation(variant: EdgeVariant): string | undefined {
  if (variant === "left") return "rotate(-90)";
  if (variant === "right") return "rotate(90)";
  return undefined;
}

/**
 * One side of the frame.
 *
 * The `<svg>` carries no `viewBox`, so pattern user units are CSS pixels and
 * the ornament stays at 1:1. Only the element's length varies (CSS controls
 * it), never the ornament's proportions.
 */
function Edge({ variant, patternId }: { variant: EdgeVariant; patternId: string }) {
  return (
    <svg
      className={`${styles.edge} ${styles[variant]}`}
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width={TILE_WIDTH}
          height={TILE_HEIGHT}
          patternTransform={patternRotation(variant)}
        >
          <image
            href={BORDER_SRC}
            x={IMAGE_X}
            y={IMAGE_Y}
            width={IMAGE_SIZE}
            height={IMAGE_SIZE}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}

interface OrnamentalFrameProps {
  /** Document content; it is laid out inside the frame. */
  children?: ReactNode;
  className?: string;
}

/**
 * Wraps `children` in the four-sided ornamental frame.
 *
 * The frame is purely decorative and never captures pointer events; content
 * must leave at least one band-width of padding so it cannot be overlapped.
 */
export default function OrnamentalFrame({ children, className = "" }: OrnamentalFrameProps) {
  // `useId` output can contain characters that are unsafe inside `url(#…)`,
  // so it is reduced to alphanumerics before being used as a pattern id.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  return (
    <div
      className={`${styles.frame} ${className}`}
      style={{ "--msu-band": `${BAND}px` } as CSSProperties}
    >
      <Edge variant="top" patternId={`msuOrnTop${uid}`} />
      <Edge variant="left" patternId={`msuOrnLeft${uid}`} />
      <Edge variant="right" patternId={`msuOrnRight${uid}`} />
      <Edge variant="bottom" patternId={`msuOrnBottom${uid}`} />
      {children}
    </div>
  );
}

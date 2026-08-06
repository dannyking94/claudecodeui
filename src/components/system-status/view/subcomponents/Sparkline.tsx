import { useId } from 'react';

import { HISTORY_LENGTH } from '../../hooks/useSystemStats';

export type SparklinePoint = {
  /** Epoch milliseconds the sample was taken. */
  timestamp: number;
  /** Percentage in the 0–100 range. */
  value: number;
};

type SparklineProps = {
  /** Oldest first. */
  points: SparklinePoint[];
  className?: string;
};

/**
 * The viewBox is the data space itself — one unit per second horizontally, one
 * per percent vertically — so no measuring or resize observation is needed.
 * `preserveAspectRatio="none"` lets it stretch to any container, and
 * `vector-effect="non-scaling-stroke"` keeps the line 1px through that stretch.
 */
const VIEWBOX_WIDTH = HISTORY_LENGTH - 1;
const VIEWBOX_HEIGHT = 100;
/**
 * Keeps the stroke fully inside the plot area at both extremes — an idle 0%
 * line drawn exactly on the boundary would be clipped in half by the
 * container's `overflow-hidden`.
 */
const VERTICAL_INSET = 2;
const PLOT_HEIGHT = VIEWBOX_HEIGHT - VERTICAL_INSET * 2;
/**
 * Samples arrive every second, so a larger step means sampling was stopped —
 * the panel was closed or the tab was hidden. The line must break there
 * instead of joining across a period nothing was measured.
 */
const GAP_THRESHOLD_MS = 2_500;

type Segment = { points: string; firstX: number; lastX: number };

/**
 * Places each sample at its true age and splits the series wherever sampling
 * stopped.
 *
 * Positioning by array index instead would pack a stale backlog against the
 * right edge, drawing minute-old readings as if they were current.
 */
function buildSegments(points: SparklinePoint[], now: number): Segment[] {
  const segments: Segment[] = [];
  // A plain loop rather than forEach: control-flow analysis cannot follow
  // reassignment of `current` across a callback boundary.
  let coords: string[] = [];
  let firstX = 0;
  let lastX = 0;

  const flush = () => {
    // One coordinate is a point, not a line — nothing to stroke.
    if (coords.length > 1) {
      segments.push({ points: coords.join(' '), firstX, lastX });
    }
    coords = [];
  };

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const ageSeconds = (now - point.timestamp) / 1000;
    const x = VIEWBOX_WIDTH - ageSeconds;

    // Older than the window, or clock skew put it in the future.
    if (x < 0 || x > VIEWBOX_WIDTH) {
      flush();
      continue;
    }

    const previous = points[index - 1];
    const brokeAfterGap =
      previous !== undefined && point.timestamp - previous.timestamp > GAP_THRESHOLD_MS;

    if (coords.length === 0 || brokeAfterGap) {
      flush();
      firstX = x;
    }

    const clamped = Math.min(100, Math.max(0, point.value));
    const y = VERTICAL_INSET + ((100 - clamped) / 100) * PLOT_HEIGHT;
    coords.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    lastX = x;
  }

  flush();

  return segments;
}

export default function Sparkline({ points, className }: SparklineProps) {
  const gradientId = useId();

  // Read at render so a stale series slides left and out of the window rather
  // than sitting frozen at the right edge.
  const segments = buildSegments(points, Date.now());

  // A lone point has no direction to draw; the panel shows the reading as a
  // number regardless, so an empty plot area is the honest state here.
  if (segments.length === 0) {
    return <div className={className} aria-hidden="true" />;
  }

  return (
    <svg
      className={className}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>

      {segments.map((segment) => (
        <g key={segment.points}>
          {/* Closing the path down to the baseline turns the same points into the fill. */}
          <polygon
            points={`${segment.firstX.toFixed(2)},${VIEWBOX_HEIGHT} ${segment.points} ${segment.lastX.toFixed(2)},${VIEWBOX_HEIGHT}`}
            fill={`url(#${gradientId})`}
          />
          <polyline
            points={segment.points}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </svg>
  );
}

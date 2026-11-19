/**
 * Icons of network equipment, drawn as the symbols network diagrams use. They take the same props
 * as the other icons of the app (a class name, a size) and inherit the text colour.
 */
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function glyph(name: string, shapes: ReactNode) {
  const Icon = (props: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      {shapes}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

/** A router: a circle with two arrows leaving it and two entering. */
export const RouterIcon = glyph(
  'RouterIcon',
  <>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M5.6 12h4M7.6 10l-2 2 2 2M18.4 12h-4M16.4 10l2 2-2 2M12 5.4v4M10.1 7.6 12 9.5l1.9-1.9M12 18.6v-4M10.1 16.4 12 14.5l1.9 1.9" />
  </>,
);

/** A switch: a box with traffic running both ways. */
export const SwitchIcon = glyph(
  'SwitchIcon',
  <>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
    <path d="M6.5 9.8h10M14.3 7.6l2.2 2.2-2.2 2.2M17.5 14.2h-10M9.7 12l-2.2 2.2 2.2 2.2" />
  </>,
);

/** A switch that also routes between its networks: a box with the routing circle inside. */
export const RoutingSwitchIcon = glyph(
  'RoutingSwitchIcon',
  <>
    <rect x="2.8" y="2.8" width="18.4" height="18.4" rx="3" />
    <circle cx="12" cy="12" r="3.4" />
    <path d="M12 5.6v3M10.7 6.9 12 5.6l1.3 1.3M12 18.4v-3M10.7 17.1l1.3 1.3 1.3-1.3M5.6 12h3M6.9 10.7 5.6 12l1.3 1.3M18.4 12h-3M17.1 10.7l1.3 1.3-1.3 1.3" />
  </>,
);

/** A firewall: a wall of bricks. */
export const FirewallIcon = glyph(
  'FirewallIcon',
  <>
    <rect x="2.8" y="4.5" width="18.4" height="15" rx="2" />
    <path d="M2.8 9.5h18.4M2.8 14.5h18.4M9 4.5v5M15 4.5v5M6 9.5v5M12 9.5v5M18 9.5v5M9 14.5v5M15 14.5v5" />
  </>,
);

/** An access point: a flat unit with radio waves above it. */
export const AccessPointIcon = glyph(
  'AccessPointIcon',
  <>
    <rect x="4" y="14.5" width="16" height="6" rx="3" />
    <path d="M8 17.5h.01M9.2 10.6a4 4 0 0 1 5.6 0M6.4 7.8a8 8 0 0 1 11.2 0M12 12.6h.01" />
  </>,
);

/** Several devices on one shared stretch of cable: a segment nobody manages. */
export const SegmentIcon = glyph(
  'SegmentIcon',
  <>
    <path d="M3 8.5h18M6.5 8.5v6M12 8.5v6M17.5 8.5v6" />
    <rect x="4.5" y="14.5" width="4" height="4" rx="1" />
    <rect x="10" y="14.5" width="4" height="4" rx="1" />
    <rect x="15.5" y="14.5" width="4" height="4" rx="1" />
  </>,
);

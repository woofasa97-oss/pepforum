/** Stroke icons from the prototype (24×24, currentColor). Decorative: aria-hidden. */
const PATHS = {
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  comment: 'M21 12a8 8 0 0 1-8 8H6l-3 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z',
  flag: 'M4 22V4a1 1 0 0 1 1-1h11l1 2h4v10h-6l-1-2H5',
  note: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 13h6M9 17h4',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  flask: 'M9 3h6M10 3v6L4 20a1 1 0 0 0 1 1.5h14A1 1 0 0 0 20 20L14 9V3',
  home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  server: 'M4 3h16v7H4zM4 14h16v7H4zM8 6.5h.01M8 17.5h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  star: 'm12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
  check: 'm20 6-11 11-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  lock: 'M5 11h14v11H5zM7 11V7a5 5 0 0 1 10 0v4',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z',
  plus: 'M12 5v14M5 12h14',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  thumbup: 'M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H7V10l4.5-7a2.5 2.5 0 0 1 3.5 2.9z',
  thumbdown: 'M17 14V2M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-7A2 2 0 0 1 6.5 3H17v11l-4.5 7a2.5 2.5 0 0 1-3.5-2.9z',
  chevron: 'm6 9 6 6 6-6',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7z',
  bulb: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  scale: 'M12 3v18M3 7h18M6 7l-3 7a4 4 0 0 0 6 0zM18 7l-3 7a4 4 0 0 0 6 0z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  image: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12',
  stethoscope: 'M6 3v6a4 4 0 0 0 8 0V3M10 13v2a4 4 0 0 0 8 0v-1M18 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'i' }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The maple leaf from the prototype (a single polygon in a 100×100 box). */
export const LEAF_PATH =
  'M50 0 54.6 11.7 61.3 8.2 59.7 20.4 68.9 17.9 66.4 27.6 83.3 24.5 81.1 33.2 97.6 42 92 48.7 100 60.5 80.6 61.3 82.6 71.2 61.2 66 62.7 77.9 52.8 73.7 52.8 100 47.2 100 47.2 73.7 37.3 77.9 38.8 66 17.4 71.2 19.4 61.3 0 60.5 8 48.7 2.4 42 18.9 33.2 16.7 24.5 33.6 27.6 31.1 17.9 40.3 20.4 38.7 8.2 45.4 11.7Z';

/** LEAF_PATH's vertices, for extruding the 3D hero leaf. */
export const LEAF_POINTS: readonly (readonly [number, number])[] = Array.from(
  LEAF_PATH.matchAll(/(-?[\d.]+) (-?[\d.]+)/g),
  (m) => [Number(m[1]), Number(m[2])] as const,
);

export function Leaf({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d={LEAF_PATH} />
    </svg>
  );
}

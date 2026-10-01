/** Line icons on a 16px grid, drawn in the text colour around them */
export const ICONS = {
  lock: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3 7h10v7H3z',
  cloud: 'M4.5 12.5h7a3 3 0 0 0 .4-6A4 4 0 0 0 4.3 6 3.25 3.25 0 0 0 4.5 12.5Z',
  globe:
    'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM1.5 8h13M8 1.5c1.8 1.8 2.6 4 2.6 6.5S9.8 12.7 8 14.5M8 1.5C6.2 3.3 5.4 5.5 5.4 8s.8 4.7 2.6 6.5',
  mic: 'M8 1.5a2 2 0 0 1 2 2V8a2 2 0 0 1-4 0V3.5a2 2 0 0 1 2-2ZM3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5',
  micOff:
    'M10 6.5V3.5a2 2 0 0 0-3.7-1M6 6v2a2 2 0 0 0 3.2 1.6M3.5 7.5a4.5 4.5 0 0 0 7.6 3.2M12.4 8.6c.07-.36.1-.73.1-1.1M8 12v2.5M2 2l12 12',
  camera: 'M1.5 4.5h9v7h-9zM10.5 7l4-2.5v7l-4-2.5',
  cameraOff: 'M4 4.5h6.5v4M10.5 11.5h-9v-7M10.5 7l4-2.5v7l-2.2-1.4M2 2l12 12',
  screen: 'M1.5 2.5h13v9h-13zM5.5 14.5h5M8 11.5v3',
  phone:
    'M5.5 1.5h-3a1 1 0 0 0-1 1C1.5 9 7 14.5 13.5 14.5a1 1 0 0 0 1-1v-3l-3.5-1.5-1.5 1.5a8 8 0 0 1-4-4L7 5 5.5 1.5Z',
  hangUp: 'M1.5 9.5c3.6-3.3 9.4-3.3 13 0l-1.8 2-2.7-1.2V8.4a8 8 0 0 0-4 0v1.9l-2.7 1.2-1.8-2Z',
  expand: 'M9.5 1.5h5v5M6.5 14.5h-5v-5M14.5 1.5 9.5 6.5M1.5 14.5l5-5',
  shrink: 'M14.5 6.5h-5v-5M1.5 9.5h5v5M9.5 6.5l5-5M6.5 9.5l-5 5',
  pip: 'M1.5 2.5h13v11h-13zM8.5 8.5h4v3h-4z',
  // The space's sections, and the views under the hood
  apps: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z',
  people:
    'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5M10.5 2.7a2.5 2.5 0 0 1 0 4.6M12 9.8c1.5.6 2.5 2.2 2.5 4.2',
  layers: 'M8 1.5 14.5 5 8 8.5 1.5 5ZM1.5 8 8 11.5 14.5 8M1.5 11 8 14.5 14.5 11',
  home: 'M2 7.5 8 2.5l6 5M3.5 6.5v7h9v-7',
  table: 'M1.5 2.5h13v11h-13zM1.5 6h13M1.5 9.5h13M6 6v7.5',
  compass: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM10.5 5.5 9 9l-3.5 1.5L7 7z',
  search: 'M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM10.3 10.3l4 4',
  network: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z',
  // Apps
  chat: 'M2.5 2.5h11V11H7l-3.5 3v-3h-1z',
  board: 'M2 2.5h3.5v11H2zM6.25 2.5h3.5v7h-3.5zM10.5 2.5H14v9h-3.5z',
  poll: 'M3 13.5V8M8 13.5V2.5M13 13.5V5.5',
  decide: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM5 8.2l2 2L11 6',
  sparkle: 'M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z',
  plus: 'M8 3v10M3 8h10',
  terminal: 'M1.5 2.5h13v11h-13zM4.5 6l2 2-2 2M8 10.5h3.5',
  back: 'M10 3 5 8l5 5',
  bell: 'M4 11.5V7a4 4 0 0 1 8 0v4.5l1.5 1.5h-11ZM6.5 13.5a1.5 1.5 0 0 0 3 0',
  bellOn: 'M4 11.5V7a4 4 0 0 1 8 0v4.5l1.5 1.5h-11ZM6.5 13.5a1.5 1.5 0 0 0 3 0M6 7.5l1.5 1.5L10 6.5',
  chevron: 'M6 4l4 4-4 4',
  menu: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
  bolt: 'M9 1.5 3 9h4.5L7 14.5 13 7H8.5Z',
} as const;

export type IconName = keyof typeof ICONS;

/** One of ours by name, or a path of its own on the same grid: what a mini app brings (`fromMiniApp`) */
export type Glyph = IconName | { readonly path: string };

export function Icon({ name, size = 16 }: { name: Glyph; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path d={typeof name === 'string' ? ICONS[name] : name.path} />
    </svg>
  );
}

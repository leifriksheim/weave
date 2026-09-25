/** Line icons on a 16px grid, drawn in the text colour around them */
export const ICONS = {
  lock: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3 7h10v7H3z',
  globe: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM1.5 8h13M8 1.5c1.8 1.8 2.6 4 2.6 6.5S9.8 12.7 8 14.5M8 1.5C6.2 3.3 5.4 5.5 5.4 8s.8 4.7 2.6 6.5',
  mic: 'M8 1.5a2 2 0 0 1 2 2V8a2 2 0 0 1-4 0V3.5a2 2 0 0 1 2-2ZM3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5',
  micOff: 'M10 6.5V3.5a2 2 0 0 0-3.7-1M6 6v2a2 2 0 0 0 3.2 1.6M3.5 7.5a4.5 4.5 0 0 0 7.6 3.2M12.4 8.6c.07-.36.1-.73.1-1.1M8 12v2.5M2 2l12 12',
  camera: 'M1.5 4.5h9v7h-9zM10.5 7l4-2.5v7l-4-2.5',
  cameraOff: 'M4 4.5h6.5v4M10.5 11.5h-9v-7M10.5 7l4-2.5v7l-2.2-1.4M2 2l12 12',
  screen: 'M1.5 2.5h13v9h-13zM5.5 14.5h5M8 11.5v3',
  phone: 'M5.5 1.5h-3a1 1 0 0 0-1 1C1.5 9 7 14.5 13.5 14.5a1 1 0 0 0 1-1v-3l-3.5-1.5-1.5 1.5a8 8 0 0 1-4-4L7 5 5.5 1.5Z',
  hangUp: 'M1.5 9.5c3.6-3.3 9.4-3.3 13 0l-1.8 2-2.7-1.2V8.4a8 8 0 0 0-4 0v1.9l-2.7 1.2-1.8-2Z',
  expand: 'M9.5 1.5h5v5M6.5 14.5h-5v-5M14.5 1.5 9.5 6.5M1.5 14.5l5-5',
  shrink: 'M14.5 6.5h-5v-5M1.5 9.5h5v5M9.5 6.5l5-5M6.5 9.5l-5 5',
  pip: 'M1.5 2.5h13v11h-13zM8.5 8.5h4v3h-4z',

} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
      <path d={ICONS[name]} />
    </svg>
  );
}

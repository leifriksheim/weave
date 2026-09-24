/** Line icons on a 16px grid, drawn in the text colour around them */
export const ICONS = {
  things: 'M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z',
  explore:
    'M4 2.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM12 2.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM8 10.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM5.75 4h4.5M4.9 5.6l2.2 4.8M11.1 5.6l-2.2 4.8',
  query: 'M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM10.2 10.2l3.3 3.3',
  people:
    'M6 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM1.5 13.5c.5-2.4 2.3-3.8 4.5-3.8s4 1.4 4.5 3.8M10.5 2.7a2.5 2.5 0 0 1 0 4.6M12 9.9c1.3.5 2.2 1.8 2.5 3.6',
  lock: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3 7h10v7H3z',
  globe: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM1.5 8h13M8 1.5c1.8 1.8 2.6 4 2.6 6.5S9.8 12.7 8 14.5M8 1.5C6.2 3.3 5.4 5.5 5.4 8s.8 4.7 2.6 6.5',
} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
      <path d={ICONS[name]} />
    </svg>
  );
}

import type { CSSProperties } from 'react';

// Recharts supplies inline white/series-colored defaults. Set every text layer
// explicitly so all default tooltips share the custom history tooltip's theme.
export const chartTooltipTheme = {
  contentStyle: {
    backgroundColor: 'var(--chart-tooltip-background)',
    color: 'var(--chart-tooltip-foreground)',
    border: '1px solid var(--chart-tooltip-border)',
    borderRadius: 8,
    padding: '10px 13px',
    fontSize: 12,
    boxShadow: '0 8px 20px #0005',
    maxWidth: 'calc(100vw - 32px)',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  labelStyle: { color: 'var(--chart-tooltip-label)', marginBottom: 6 },
  itemStyle: { color: 'var(--chart-tooltip-foreground)' },
};

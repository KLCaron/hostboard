export interface WidgetPreference {
  id: string;
  visible: boolean;
  width: "half" | "full";
  height: "auto" | "tall";
  host?: string;
  metric?: string;
}
export interface Layout {
  version: 1;
  widgets: WidgetPreference[];
}
export function normalizeLayout(
  value: unknown,
  defaults: WidgetPreference[],
): Layout {
  const source =
    (value as Layout)?.version === 1 && Array.isArray((value as Layout).widgets)
      ? (value as Layout).widgets
      : [];
  const known = new Map(defaults.map((w) => [w.id, w]));
  const result: WidgetPreference[] = [];
  for (const w of source) {
    const d = known.get(w?.id);
    if (!d) continue;
    known.delete(w.id);
    result.push({
      ...d,
      visible: typeof w.visible === "boolean" ? w.visible : d.visible,
      width:
        w.width === "full" ? "full" : w.width === "half" ? "half" : d.width,
      height: w.height === "tall" ? "tall" : "auto",
      host:
        typeof w.host === "string" && w.host.length <= 64 ? w.host : undefined,
      metric:
        typeof w.metric === "string" && w.metric.length <= 512
          ? w.metric
          : undefined,
    });
  }
  return { version: 1, widgets: [...result, ...known.values()] };
}
export function moveWidget(layout: Layout, id: string, before: string): Layout {
  const widgets = [...layout.widgets],
    from = widgets.findIndex((w) => w.id === id),
    to = widgets.findIndex((w) => w.id === before);
  if (from < 0 || to < 0 || from === to) return layout;
  const [item] = widgets.splice(from, 1);
  widgets.splice(to, 0, item);
  return { ...layout, widgets };
}

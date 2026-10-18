import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLayout,
  moveWidget,
  type WidgetPreference,
} from "../src/layout.js";
const defaults: WidgetPreference[] = [
  { id: "health", visible: true, width: "full", height: "auto" },
  { id: "host", visible: true, width: "half", height: "auto" },
];
test("layout normalization bounds corrupt preferences, removes duplicate/unknown widgets and discovers added hosts", () => {
  assert.deepEqual(normalizeLayout(null, defaults).widgets, defaults);
  const l = normalizeLayout(
    {
      version: 1,
      widgets: [
        {
          id: "host",
          visible: false,
          width: "unbounded",
          height: "huge",
          metric: "x".repeat(1000),
        },
        { id: "host", visible: true },
        { id: "removed", visible: true },
      ],
    },
    defaults,
  );
  assert.deepEqual(
    l.widgets.map((w) => w.id),
    ["host", "health"],
  );
  assert.equal(l.widgets[0].visible, false);
  assert.equal(l.widgets[0].width, "half");
  assert.equal(l.widgets[0].height, "auto");
  assert.equal(l.widgets[0].metric, undefined);
  assert.deepEqual(
    moveWidget(l, "health", "host").widgets.map((w) => w.id),
    ["health", "host"],
  );
  assert.deepEqual(
    l.widgets.map((w) => w.id),
    ["host", "health"],
  );
  assert.equal(moveWidget(l, "unknown", "host"), l);
});

# UI interaction patterns

Hostboard shares its interaction tokens and primitives in `src/style.css`. Use the existing patterns when adding controls:

- **Navigation actions:** semantic anchors with `action-link` provide a compact, bordered surface at rest. Keep meaningful `href` destinations so middle click, new tabs and browser history work. Use buttons for dialogs and inline disclosure instead.
- **Contextual actions:** `text-link` provides a visible underline, comfortable spacing and stronger hover treatment. Use `context-actions` to wrap adjacent links/buttons without punctuation separators. Informational values and status labels have no interaction styling.
- **Host alerts:** a nonzero alert count on Overview or Servers is a native link to Issues, filtered to that server's active metric alerts. The destination survives reloads, and each alert opens its existing investigation view. The link is separate from the host's expand control.
- **Expandable rows:** native `details`/`summary` share a rounded surface, chevron, focus ring and persistent expanded indicator. The browser supplies keyboard activation and accessible expanded state. Keep nested actions in the detail body, outside the summary. Only the summary toggles the row.
- **Selection:** use controlled `aria-pressed`, `aria-selected`, `aria-current` or a checked input. The shared selected surface includes a leading indicator or border as well as color. Hover must not erase persistent selection. `TabList` provides arrow, Home and End navigation with automatic activation; only the active tab belongs to the Tab sequence.
- **Other controls:** native inputs/selects keep their field surfaces. Buttons expose disabled state and busy operations can use `aria-busy`. Dialogs use native modal behavior for focus containment, Escape and focus return. Coarse pointers receive larger targets; reduced-motion preferences suppress surface transitions.

The seven-section review covers Overview actions/customization, Servers expansion/diagnostics/charts, Services checks/container resources, Logs sources/search/ranges/selection/export, Issues filters/incidents and Settings editing/associations/operations. Updates adds read-only inventory disclosure, explicit stale/unavailable states and status-only refresh. Logs remains a full-width explorer; metric values, reachability labels and operational status remain information.

Firefox desktop and touch-width regressions check default, hover, focus, selection, expansion, disabled and processing states, navigation semantics, nested controls and page overflow. Screenshots use controlled fixture data and remain ignored local artifacts. These checks do not constitute a full WCAG audit.

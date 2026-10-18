// SPDX-License-Identifier: AGPL-3.0-only
import type { HTMLAttributes, KeyboardEvent } from 'react';

/** Automatic activation for the shared horizontal tabs, including wrapped layouts. */
export function TabList({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  }
  return <div {...props} role="tablist" onKeyDown={move}>{children}</div>;
}

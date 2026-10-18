import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { readPreference, savePreference } from "./preferences";
export interface Display {
  refreshSeconds: number;
  temperature: "C" | "F";
  range: "15m" | "1h" | "6h" | "24h";
  landing: "overview" | "servers" | "services" | "logs" | "issues" | "settings";
  compact: boolean;
}
export const displayDefaults: Display = {
  refreshSeconds: 10,
  temperature: "C",
  range: "1h",
  landing: "overview",
  compact: false,
};
function valid(v: unknown): v is Display {
  const x = v as Display;
  return (
    !!x &&
    Number.isInteger(x.refreshSeconds) &&
    x.refreshSeconds >= 10 &&
    x.refreshSeconds <= 300 &&
    ["C", "F"].includes(x.temperature) &&
    ["15m", "1h", "6h", "24h"].includes(x.range) &&
    ["overview", "servers", "services", "logs", "issues", "settings"].includes(
      x.landing,
    ) &&
    typeof x.compact === "boolean"
  );
}
const Context = createContext(displayDefaults);
export function saveDisplay(value: Display | null) {
  if (!savePreference("display", value)) return false;
  savePreference("range", value?.range ?? null);
  savePreference("chartRange", value?.range ?? null);
  window.dispatchEvent(new Event("hostboard:display"));
  return true;
}
export function DisplayProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<Display>(() =>
    readPreference("display", displayDefaults, valid),
  );
  useEffect(() => {
    let stopped = false;
    async function load() {
      let defaults = displayDefaults;
      try {
        const r = await fetch("/api/preferences");
        const v = await r.json();
        if (r.ok && valid(v.general)) defaults = v.general;
      } catch {}
      if (!stopped) setValue(readPreference("display", defaults, valid));
    }
    void load();
    window.addEventListener("hostboard:display", load);
    window.addEventListener("storage", load);
    return () => {
      stopped = true;
      window.removeEventListener("hostboard:display", load);
      window.removeEventListener("storage", load);
    };
  }, []);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useDisplay = () => useContext(Context);
export const temperature = (
  value: number | null | undefined,
  unit: "C" | "F",
  digits = 1,
) =>
  value == null
    ? "—"
    : `${(unit === "F" ? (value * 9) / 5 + 32 : value).toLocaleString(undefined, { maximumFractionDigits: digits })} °${unit}`;

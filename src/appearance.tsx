import { useEffect, useState } from "react";
import { CaretDown, Desktop, Sun, Moon } from "@phosphor-icons/react";
import { api, send } from "./api";
import type { DocumentFormat } from "./document-format";
type GoogleFont = { family: string; category: string };
export function documentFontFamily(font: string) {
  if (["JetBrains Mono", "Courier Prime"].includes(font))
    return `"${font}", ui-monospace, monospace`;
  if (font === "DM Sans") return '"DM Sans Variable", sans-serif';
  if (font === "monospace") return "ui-monospace, monospace";
  if (["Asul", "Lora", "Georgia"].includes(font))
    return `"${font}", Georgia, serif`;
  return `"${font}", sans-serif`;
}
const bundledFonts = [
  "JetBrains Mono",
  "Courier Prime",
  "IBM Plex Sans",
  "DM Sans",
  "Lora",
  "Georgia",
  "monospace",
];
let catalogRequest: Promise<{ fonts: GoogleFont[] }> | null = null;
function loadFontCatalog() {
  return (catalogRequest ||= api<{ fonts: GoogleFont[] }>(
    "/font-catalog.json",
  ).catch((error) => {
    catalogRequest = null;
    throw error;
  }));
}
type WritingDevice = "phone" | "tablet" | "desktop";
const defaultSizes = { phone: 12, tablet: 15, desktop: 18 };
function writingDevice(): WritingDevice {
  const touch = window.matchMedia("(pointer: coarse)").matches;
  if (
    window.innerWidth <= 760 ||
    (touch && Math.min(window.screen.width, window.screen.height) <= 600)
  )
    return "phone";
  const iPad =
    /iPad/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return iPad || window.innerWidth <= 1180 ? "tablet" : "desktop";
}
type WritingPreferences = {
  font: string;
  sizes: Partial<Record<WritingDevice, number>>;
  lineHeight: number;
  pageWidth: number | null;
};
const preferenceKey = (format: DocumentFormat) => `locdoc.writing.${format}`;
function storedObject(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
function bounded(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
function readWritingPreferences(format: DocumentFormat): WritingPreferences {
  const saved = storedObject(preferenceKey(format));
  const legacy = format === "markdown" && !saved;
  let font = format === "fountain" ? "Courier Prime" : "JetBrains Mono";
  if (typeof saved?.font === "string" && saved.font.trim()) font = saved.font;
  else if (legacy) {
    const previous = localStorage.getItem("locdoc.font");
    const oldDefault =
      localStorage.getItem("locdoc.typography") !== "jetbrains-v1" &&
      (!previous || ["Asul", "DM Sans", "IBM Plex Sans"].includes(previous));
    if (previous && !oldDefault) font = previous;
  }
  const rawSizes = legacy ? storedObject("locdoc.fontSizes") : saved?.sizes;
  const sizes: WritingPreferences["sizes"] = {};
  for (const device of Object.keys(defaultSizes) as WritingDevice[]) {
    const value = rawSizes?.[device];
    if (typeof value === "number" && Number.isFinite(value))
      sizes[device] = bounded(value, 10, 28, defaultSizes[device]);
  }
  if (legacy && localStorage.getItem("locdoc.fontSizes") === null) {
    const previous = Number(localStorage.getItem("locdoc.fontSize"));
    const oldDefault =
      previous === 20 ||
      (previous === 17 && !localStorage.getItem("locdoc.typography"));
    if (previous >= 10 && previous <= 28 && !oldDefault)
      sizes[writingDevice()] = previous;
  }
  const lineHeight = legacy
    ? Number(localStorage.getItem("locdoc.lineHeight") || 1.85)
    : saved?.lineHeight;
  const width = legacy
    ? Number(localStorage.getItem("locdoc.pageWidth"))
    : saved?.pageWidth;
  return {
    font,
    sizes,
    lineHeight: bounded(lineHeight, 1.2, 2.4, 1.85),
    pageWidth:
      typeof width === "number" && Number.isFinite(width) && width > 0
        ? bounded(width, 480, 1400, 890)
        : null,
  };
}
function useWritingAppearance(format: DocumentFormat, device: WritingDevice) {
  const [preferences, setPreferences] = useState(() =>
    readWritingPreferences(format),
  );
  const key = preferenceKey(format);
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(preferences));
  }, [key, preferences]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === key || event.key === null)
      )
        setPreferences(readWritingPreferences(format));
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [format, key]);
  const update = <K extends keyof WritingPreferences>(
    property: K,
    value: WritingPreferences[K],
  ) => setPreferences((current) => ({ ...current, [property]: value }));
  return {
    format,
    font: preferences.font,
    setFont: (value: string) => update("font", value),
    fontSize: preferences.sizes[device] ?? defaultSizes[device],
    defaultFontSize: defaultSizes[device],
    setFontSize: (value: number | ((current: number) => number)) =>
      setPreferences((current) => ({
        ...current,
        sizes: {
          ...current.sizes,
          [device]: bounded(
            typeof value === "function"
              ? value(current.sizes[device] ?? defaultSizes[device])
              : value,
            10,
            28,
            defaultSizes[device],
          ),
        },
      })),
    lineHeight: preferences.lineHeight,
    setLineHeight: (value: number) =>
      update("lineHeight", bounded(value, 1.2, 2.4, 1.85)),
    pageWidth: preferences.pageWidth,
    setPageWidth: (value: number | null) =>
      update(
        "pageWidth",
        value === null ? null : bounded(value, 480, 1400, 890),
      ),
  };
}
export function useAppearance() {
  const [device, setDevice] = useState(writingDevice);
  useEffect(() => {
    const update = () => setDevice(writingDevice());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const markdown = useWritingAppearance("markdown", device);
  const fountain = useWritingAppearance("fountain", device);
  const [theme, setTheme] = useState(
    localStorage.getItem("locdoc.theme") || "auto",
  );
  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "auto" ? (preference.matches ? "dark" : "light") : theme;
    };
    apply();
    localStorage.setItem("locdoc.theme", theme);
    preference.addEventListener("change", apply);
    return () => preference.removeEventListener("change", apply);
  }, [theme]);
  return {
    forFormat: (format: DocumentFormat) => ({
      ...(format === "fountain" ? fountain : markdown),
      theme,
      setTheme,
    }),
  };
}
export function AppearanceSettings({
  owner,
  value,
}: {
  owner: boolean;
  value: ReturnType<ReturnType<typeof useAppearance>["forFormat"]>;
}) {
  const {
    format,
    font,
    setFont,
    fontSize,
    setFontSize,
    defaultFontSize,
    lineHeight,
    setLineHeight,
    pageWidth,
    setPageWidth,
    theme,
    setTheme,
  } = value;
  const [fonts, setFonts] = useState<string[]>([]);
  const [newFont, setNewFont] = useState("");
  const [fontCatalog, setFontCatalog] = useState<GoogleFont[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const fontQuery = newFont.trim().toLowerCase();
  const matchingFonts = fontQuery
    ? fontCatalog
        .filter((f) =>
          fontQuery
            .split(/\s+/)
            .every((part) =>
              `${f.family} ${f.category}`.toLowerCase().includes(part),
            ),
        )
        .sort(
          (a, b) =>
            Number(!a.family.toLowerCase().startsWith(fontQuery)) -
              Number(!b.family.toLowerCase().startsWith(fontQuery)) ||
            a.family.localeCompare(b.family),
        )
        .slice(0, 6)
    : [];
  const [busy, setBusy] = useState(false);
  const [notice, tell] = useState("");
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      tell((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    api<{ fonts: string[] }>("/api/fonts")
      .then((d) => setFonts(d.fonts))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    setCatalogLoading(true);
    setCatalogError("");
    loadFontCatalog()
      .then((data) => {
        if (active) setFontCatalog(data.fonts);
      })
      .catch(() => {
        if (active) setCatalogError("Could not load font search. Try again.");
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, [owner, catalogAttempt]);
  const installFont = (family = newFont) =>
    action(async () => {
      const result = await api<{ family: string }>(
        "/api/fonts",
        send("POST", { family }),
      );
      setFonts((f) => Array.from(new Set([...f, result.family])));
      setFont(result.family);
      setNewFont("");
      const css = document.getElementById("installed-fonts") as HTMLLinkElement;
      css.href = `/api/fonts.css?v=${Date.now()}`;
      tell(`${result.family} installed locally.`);
    });
  return (
    <>
      {" "}
      <>
        <p className="dialog-description">
          Font and spacing settings apply to all{" "}
          {format === "fountain" ? "Fountain" : "Markdown"} files in this
          browser.
        </p>
        <label className="field-label" htmlFor="font">
          Document font
        </label>
        <div className="select-field">
          <select
            id="font"
            className="text-input"
            value={font}
            onChange={(e) => setFont(e.target.value)}
          >
            {Array.from(new Set([...bundledFonts, ...fonts])).map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <CaretDown size={16} className="select-arrow" aria-hidden="true" />
        </div>
        <div className="writing-controls">
          <div className="writing-control">
            <div className="writing-control-label">
              <label htmlFor="font-size">Text size</label>
              <output htmlFor="font-size">{fontSize} px</output>
            </div>
            <input
              id="font-size"
              type="range"
              min={10}
              max={28}
              step={1}
              value={fontSize}
              aria-valuetext={`${fontSize} pixels`}
              onChange={(e) => setFontSize(Number(e.target.value))}
            />
          </div>
          <div className="writing-control">
            <div className="writing-control-label">
              <label htmlFor="line-height">Line height</label>
              <output htmlFor="line-height">{lineHeight.toFixed(2)}×</output>
            </div>
            <input
              id="line-height"
              type="range"
              min={1.2}
              max={2.4}
              step={0.05}
              value={lineHeight}
              aria-valuetext={`${lineHeight.toFixed(2)} times text size`}
              onChange={(e) => setLineHeight(Number(e.target.value))}
            />
          </div>
          <div className="writing-control">
            <div className="writing-control-label">
              <label htmlFor="page-width">Page width</label>
              <output htmlFor="page-width">
                {pageWidth === null ? "Auto" : `${pageWidth} px`}
              </output>
            </div>
            <input
              id="page-width"
              type="range"
              min={480}
              max={1400}
              step={10}
              value={pageWidth ?? 890}
              aria-valuetext={
                pageWidth === null ? "Automatic width" : `${pageWidth} pixels`
              }
              aria-describedby="page-width-help"
              onChange={(e) => setPageWidth(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="writing-controls-help">
          <p id="page-width-help" className="field-help">
            Maximum page width. Fits smaller screens automatically.
          </p>
          <button
            className="text-button"
            disabled={
              fontSize === defaultFontSize &&
              lineHeight === 1.85 &&
              pageWidth === null
            }
            onClick={() => {
              setFontSize(defaultFontSize);
              setLineHeight(1.85);
              setPageWidth(null);
            }}
          >
            Reset size &amp; spacing
          </button>
        </div>
        <div
          className="font-preview"
          style={{ fontFamily: documentFontFamily(font), fontSize, lineHeight }}
        >
          <strong>A space for your next idea.</strong>
          <p>The best writing starts with a little room to think.</p>
        </div>
        {owner && (
          <>
            <label className="field-label" htmlFor="install-font">
              Search Google Fonts
            </label>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const exact = matchingFonts.find(
                  (f) => f.family.toLowerCase() === fontQuery,
                );
                if (exact) {
                  if (
                    bundledFonts.includes(exact.family) ||
                    fonts.includes(exact.family)
                  )
                    setFont(exact.family);
                  else installFont(exact.family);
                }
              }}
            >
              <input
                id="install-font"
                className="text-input"
                type="search"
                placeholder="Search by name or style…"
                autoComplete="off"
                aria-controls="font-results"
                value={newFont}
                onChange={(e) => setNewFont(e.target.value)}
              />
            </form>
            {catalogLoading && (
              <p className="field-help" role="status">
                Loading font search…
              </p>
            )}
            {catalogError && (
              <p className="field-help" role="status">
                {catalogError}{" "}
                <button
                  className="text-button"
                  onClick={() => setCatalogAttempt((n) => n + 1)}
                >
                  Retry
                </button>
              </p>
            )}
            {fontQuery && !catalogLoading && !catalogError && (
              <ul
                className="font-results"
                id="font-results"
                aria-label="Google Fonts search results"
              >
                {matchingFonts.map((f) => {
                  const available =
                    bundledFonts.includes(f.family) || fonts.includes(f.family);
                  return (
                    <li key={f.family}>
                      <span>
                        <strong>{f.family}</strong>
                        <small>{f.category}</small>
                      </span>
                      <button
                        className="button quiet small-button"
                        disabled={busy}
                        aria-label={`${available ? "Use" : "Install"} ${f.family}`}
                        onClick={() =>
                          available ? setFont(f.family) : installFont(f.family)
                        }
                      >
                        {available ? "Use" : "Install"}
                      </button>
                    </li>
                  );
                })}
                {!matchingFonts.length && (
                  <li className="font-no-results" role="status">
                    No matching fonts. Try another name or style.
                  </li>
                )}
              </ul>
            )}
            <p className="field-help">
              Search{" "}
              {fontCatalog.length ? fontCatalog.length.toLocaleString() : "the"}{" "}
              Google Fonts families. Installed fonts are saved and served
              locally.
            </p>
          </>
        )}
        <label className="field-label">Appearance</label>
        <p className="field-help">
          Auto follows your device and switches when its appearance changes.
        </p>
        <div className="theme-buttons">
          {[
            ["auto", Desktop, "Auto"],
            ["light", Sun, "Light"],
            ["dark", Moon, "Dark"],
          ].map(([t, Icon, label]) => {
            const Component = Icon as typeof Sun;
            return (
              <button
                key={t as string}
                className={theme === t ? "active" : ""}
                aria-pressed={theme === t}
                onClick={() => setTheme(t as string)}
              >
                <Component size={18} />
                {label as string}
              </button>
            );
          })}
        </div>
      </>
      {notice && (
        <p className="field-help" role="status">
          {notice}
        </p>
      )}
    </>
  );
}

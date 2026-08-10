import { useEffect, useRef } from "react";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import UniverPresetDocsCoreEnUs from "@univerjs/preset-docs-core/locales/en-US";
import { LocaleType, LogLevel, createUniver, defaultTheme, mergeLocales } from "@univerjs/presets";
import "@univerjs/preset-docs-core/lib/index.css";

const CONTAINER_ID = "univer-container";

export function DocumentApp() {
  const mounted = useRef(false);

  useEffect(() => {
    // Guards against React StrictMode's double-invoked effects in dev,
    // which would otherwise call createUniver() twice on the same container.
    if (mounted.current) return;
    mounted.current = true;

    const { univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: {
        [LocaleType.EN_US]: mergeLocales(UniverPresetDocsCoreEnUs),
      },
      logLevel: LogLevel.WARN,
      theme: defaultTheme,
      presets: [
        UniverDocsCorePreset({
          container: CONTAINER_ID,
        }),
      ],
    });

    univerAPI.createUniverDoc({ title: "Untitled document" });
  }, []);

  return (
    <div style={{ height: "100vh" }}>
      <div id={CONTAINER_ID} style={{ height: "100%" }} />
    </div>
  );
}

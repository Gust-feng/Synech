import React, { useCallback, useEffect, useState } from "react";
import {
  STYLE_REGISTRY,
  applyTheme,
  saveStyleId,
  saveColorId,
  getColorSchemesForStyle,
  getDefaultColorForStyle,
  normalizeTheme,
  type StyleDefinition,
  type ColorSchemeDefinition,
  type ThemeColorId,
  type ThemeStyleId,
} from "../app-theme";

/** Arrow-key navigation for radiogroup containers. */
function useArrowKeyHandler<TItem, TId>(
  items: readonly TItem[],
  activeId: TId,
  getId: (item: TItem) => TId,
  onSelect: (id: TId) => void,
) {
  return useCallback(
    (event: React.KeyboardEvent) => {
      const { key } = event;
      if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") return;
      event.preventDefault();

      const currentIndex = items.findIndex((item) => getId(item) === activeId);
      const direction = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + direction));
      if (nextIndex !== currentIndex) {
        onSelect(getId(items[nextIndex]));
        const container = event.currentTarget as HTMLElement;
        const buttons = container.querySelectorAll<HTMLElement>('[role="radio"]');
        buttons[nextIndex]?.focus();
      }
    },
    [items, activeId, getId, onSelect],
  );
}

export function ThemeSwitcher(props: {
  readonly activeStyleId: ThemeStyleId;
  readonly activeColorId: ThemeColorId;
  readonly onStyleChange: (styleId: ThemeStyleId) => void;
  readonly onColorChange: (colorId: ThemeColorId) => void;
}): React.ReactElement {
  const [activeStyleId, setActiveStyleId] = useState(props.activeStyleId);
  const [activeColorId, setActiveColorId] = useState(props.activeColorId);

  // Re-sync internal state when props change (e.g., parent remounts with new initial theme).
  useEffect(() => {
    setActiveStyleId(props.activeStyleId);
  }, [props.activeStyleId]);
  useEffect(() => {
    setActiveColorId(props.activeColorId);
  }, [props.activeColorId]);

  function handleStyleSelect(styleId: ThemeStyleId): void {
    if (styleId === activeStyleId) return;
    const nextColorId = getColorSchemesForStyle(styleId).some((scheme) => scheme.id === activeColorId)
      ? activeColorId
      : getDefaultColorForStyle(styleId);
    const theme = applyTheme(styleId, nextColorId);
    setActiveStyleId(theme.styleId);
    setActiveColorId(theme.colorId);
    saveStyleId(theme.styleId);
    saveColorId(theme.colorId);
    props.onStyleChange(theme.styleId);
    props.onColorChange(theme.colorId);
  }

  function handleColorSelect(colorId: ThemeColorId): void {
    if (colorId === activeColorId) return;
    const theme = applyTheme(activeStyleId, colorId);
    setActiveStyleId(theme.styleId);
    setActiveColorId(theme.colorId);
    saveStyleId(theme.styleId);
    saveColorId(theme.colorId);
    props.onStyleChange(theme.styleId);
    props.onColorChange(theme.colorId);
  }

  const currentTheme = normalizeTheme(activeStyleId, activeColorId);
  const currentSchemes = getColorSchemesForStyle(currentTheme.styleId);

  const handleStyleKeyDown = useArrowKeyHandler(
    STYLE_REGISTRY,
    currentTheme.styleId,
    (s) => s.id,
    handleStyleSelect,
  );

  const handleColorKeyDown = useArrowKeyHandler(
    currentSchemes,
    currentTheme.colorId,
    (c) => c.id,
    handleColorSelect,
  );

  return (
    <section className="settings-card theme-settings-card">
      <div className="settings-card-title-row">
        <h3>主题</h3>
      </div>

      <div
        className="theme-style-grid"
        role="radiogroup"
        aria-label="面板风格"
        onKeyDown={handleStyleKeyDown}
      >
        {STYLE_REGISTRY.map((style) => (
          <StyleOption
            key={style.id}
            style={style}
            isActive={style.id === currentTheme.styleId}
            onSelect={() => handleStyleSelect(style.id)}
          />
        ))}
      </div>

      <div className="theme-palette-section">
        <div
          className="theme-palette-row"
          role="radiogroup"
          aria-label="面板配色"
          onKeyDown={handleColorKeyDown}
        >
          {currentSchemes.map((scheme) => (
            <PaletteOption
              key={scheme.id}
              scheme={scheme}
              isActive={scheme.id === currentTheme.colorId}
              onSelect={() => handleColorSelect(scheme.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function StyleOption(props: {
  readonly style: StyleDefinition;
  readonly isActive: boolean;
  readonly onSelect: () => void;
}): React.ReactElement {
  const { style, isActive, onSelect } = props;

  return (
    <button
      type="button"
      className={`theme-style-option${isActive ? " active" : ""}`}
      onClick={onSelect}
      role="radio"
      aria-checked={isActive}
      tabIndex={isActive ? 0 : -1}
    >
      <span className="theme-style-preview" aria-hidden="true">
        <StylePreview styleId={style.id} />
      </span>
      <span className="theme-style-label">{style.label}</span>
    </button>
  );
}

function StylePreview(props: { readonly styleId: ThemeStyleId }): React.ReactElement {
  return (
    <div className={`style-preview style-preview-${props.styleId}`}>
      <div className="style-preview-frame">
        <div className="style-preview-sidebar">
          <div className="style-preview-sidebar-action" />
          <div className="style-preview-sidebar-line" />
          <div className="style-preview-sidebar-line short" />
          <div className="style-preview-sidebar-line active" />
        </div>
        <div className="style-preview-content">
          <div className="style-preview-header">
            <div className="style-preview-toggle" />
            <div className="style-preview-brand" />
          </div>
          <div className="style-preview-title" />
          <div className="style-preview-card" />
          <div className="style-preview-composer" />
        </div>
      </div>
    </div>
  );
}

function PaletteOption(props: {
  readonly scheme: ColorSchemeDefinition;
  readonly isActive: boolean;
  readonly onSelect: () => void;
}): React.ReactElement {
  const { scheme, isActive, onSelect } = props;
  const backgroundSwatch = scheme.swatches.find((s) => s.label === "背景")?.value ?? "#f3f3f3";
  const primary = scheme.swatches.find((s) => s.label === "主色")?.value ?? "#888";
  const secondary = scheme.swatches.find((s) => s.label === "辅色")?.value ?? "#aaa";
  const isSystemPreview = scheme.id === "system";
  const background = isSystemPreview
    ? `linear-gradient(135deg, ${backgroundSwatch} 0 50%, #0f131a 50% 100%)`
    : backgroundSwatch;
  const isDarkPreview = scheme.id === "dark";
  const previewInk = isDarkPreview ? "#e7edf6" : "#18202d";
  const previewBorder = isDarkPreview ? "#2a313c" : "#d9e0ea";
  const previewSurface = isDarkPreview ? "#171b22" : "#ffffff";

  return (
    <button
      type="button"
      className={`theme-palette-option${isActive ? " active" : ""}`}
      onClick={onSelect}
      role="radio"
      aria-checked={isActive}
      aria-label={scheme.label}
      tabIndex={isActive ? 0 : -1}
    >
      <span className="theme-palette-preview" aria-hidden="true">
        <span
          className="theme-palette-preview-canvas"
          style={{
            background,
            "--palette-preview-ink": previewInk,
            "--palette-preview-border": previewBorder,
            "--palette-preview-surface": previewSurface,
            "--palette-preview-primary": primary,
            "--palette-preview-secondary": secondary,
          } as React.CSSProperties}
        >
          <span className="theme-palette-preview-sidebar" />
          <span
            className="theme-palette-preview-line"
            style={{
              background: primary,
            }}
          />
          <span className="theme-palette-preview-line short" />
          <span
            className="theme-palette-preview-chip"
            style={{
              background: secondary,
            }}
          />
        </span>
      </span>
      <span
        className="theme-palette-swatch"
        style={{
          background: `linear-gradient(135deg, ${primary} 0 50%, ${secondary} 50% 100%)`,
        }}
      />
      <span className="theme-palette-label">{scheme.label}</span>
    </button>
  );
}
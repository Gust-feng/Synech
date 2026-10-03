import { SvgMark } from "../../../components/svg-mark";
import React from "react";
import { CloudCog } from "lucide-react";
import { resolveModelProviderLogo } from "./provider-logos";
import type { ModelProviderListItem } from "./settings-projection";

export function ModelIcon({ svg }: { readonly svg?: string }): React.ReactElement {
  return (
    <span className="model-row-icon" aria-hidden="true">
      {svg === undefined ? <CloudCog size={14} /> : <SvgMark svg={svg} />}
    </span>
  );
}

export function ProviderLogo({ item, large = false }: { readonly item: ModelProviderListItem; readonly large?: boolean }): React.ReactElement {
  const logo = resolveModelProviderLogo(item);
  return (
    <span className={`provider-logo ${logo.tone} ${large ? "large" : ""}`}>
      {logo.imageSrc === undefined ? (
        <SvgMark className={`provider-logo-svg ${logo.tone}`} svg={logo.svg ?? ""} />
      ) : (
        <img className="provider-logo-image" src={logo.imageSrc} alt="" aria-hidden="true" />
      )}
    </span>
  );
}

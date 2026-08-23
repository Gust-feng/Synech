import React from "react";
import { CloudCog } from "lucide-react";
import { resolveModelProviderLogo } from "../model-provider-logos";
import type { ModelProviderListItem } from "./model-settings-projection";

export function ModelIcon({ svg }: { readonly svg?: string }): React.ReactElement {
  return (
    <span className="model-row-icon" aria-hidden="true">
      {svg === undefined ? <CloudCog size={14} /> : <span dangerouslySetInnerHTML={{ __html: svg }} />}
    </span>
  );
}

export function ProviderLogo({ item, large = false }: { readonly item: ModelProviderListItem; readonly large?: boolean }): React.ReactElement {
  const logo = resolveModelProviderLogo(item);
  return (
    <span className={`provider-logo ${logo.tone} ${large ? "large" : ""}`}>
      {logo.imageSrc === undefined ? (
        <span className={`provider-logo-svg ${logo.tone}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: logo.svg ?? "" }} />
      ) : (
        <img className="provider-logo-image" src={logo.imageSrc} alt="" aria-hidden="true" />
      )}
    </span>
  );
}
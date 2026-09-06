import { useState } from "react";
import { CollaborationRulesPanel } from "./CollaborationRulesPanel";
import { MemorySettingsPanel, type MemorySettingsScope } from "./MemorySettingsPanel";
import { PathDependenciesPanel } from "./PathDependenciesPanel";
import "./memory.css";

type MemoryCenterSection = "rules" | "methods" | "implicit";

const MEMORY_SECTIONS: readonly {
  readonly id: MemoryCenterSection;
  readonly title: string;
  readonly caption: string;
}[] = [
  { id: "rules", title: "协作规则", caption: "你维护的长期协作要求" },
  { id: "methods", title: "路径依赖", caption: "可复用的方法与流程" },
  { id: "implicit", title: "自动记忆", caption: "Space 级后台提炼与自动使用" },
];

export function MemoryCenterPanel(props: {
  readonly scope: MemorySettingsScope | null;
  readonly onOpenConversation?: (conversationId: string) => void;
}): React.ReactElement {
  const [section, setSection] = useState<MemoryCenterSection>("rules");
  return (
    <section className="memory-center" aria-label="记忆设置">
      <nav className="memory-center-section-nav" aria-label="记忆类别">
        {MEMORY_SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="memory-center-section-item"
            aria-current={section === item.id ? "page" : undefined}
            data-active={section === item.id}
            onClick={() => setSection(item.id)}
          >
            <span>{item.title}</span>
            <small>{item.caption}</small>
          </button>
        ))}
      </nav>
      <div className="memory-center-body">
        {section === "rules" && <CollaborationRulesPanel scope={props.scope} />}
        {section === "methods" && <PathDependenciesPanel scope={props.scope} />}
        {section === "implicit" && <MemorySettingsPanel scope={props.scope}  onOpenConversation={props.onOpenConversation} />}
      </div>
    </section>
  );
}

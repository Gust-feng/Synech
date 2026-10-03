import { useId, useRef, useState } from "react";
import { Brain, SlidersHorizontal } from "lucide-react";
import { CollaborationRulesPanel } from "./CollaborationRulesPanel";
import { MemorySettingsPanel, type MemorySettingsScope } from "./MemorySettingsPanel";
import "./memory.css";

type MemoryCenterSection = "rules" | "memory";
const MEMORY_SECTIONS = [
  { id: "memory", title: "记忆", icon: Brain },
  { id: "rules", title: "协作规则", icon: SlidersHorizontal },
] as const;

export function MemoryCenterPanel(props: {
  readonly scope: MemorySettingsScope | null;
  readonly onOpenConversation?: (conversationId: string) => void;
}): React.ReactElement {
  const [section, setSection] = useState<MemoryCenterSection>("memory");
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const owner = props.scope?.owner;
  const ownerKey = owner === undefined ? "global" : `${owner.kind}:${owner.id}`;
  return <section className="memory-center" aria-label="记忆与协作规则设置">
    <div className="memory-center-toolbar">
      <div className="memory-center-tabs" role="tablist" aria-label="长期上下文" onKeyDown={event => {
        const active = MEMORY_SECTIONS.findIndex(item => item.id === section);
        const next = event.key === "ArrowRight" ? (active + 1) % 2 : event.key === "ArrowLeft" ? (active - 1 + MEMORY_SECTIONS.length) % MEMORY_SECTIONS.length
          : event.key === "Home" ? 0 : event.key === "End" ? 1 : undefined;
        if (next === undefined) return;
        event.preventDefault(); setSection(MEMORY_SECTIONS[next].id); tabs.current[next]?.focus();
      }}>
        {MEMORY_SECTIONS.map((item, index) => <button
          key={item.id} ref={element => { tabs.current[index] = element; }} type="button" role="tab"
          id={id + "-" + item.id} aria-controls={id + "-panel-" + item.id} aria-selected={section === item.id}
          tabIndex={section === item.id ? 0 : -1} onClick={() => setSection(item.id)}
        ><item.icon size={16} strokeWidth={1.8} aria-hidden="true" /><span>{item.title}</span></button>)}
      </div>
    </div>
    <div className="memory-center-body">
      <div className="memory-center-content">
        <div className="memory-view" role="tabpanel" tabIndex={0} hidden={section !== "memory"}
          id={id + "-panel-memory"} aria-labelledby={id + "-memory"}>
          <MemorySettingsPanel key={ownerKey} scope={props.scope} onOpenConversation={props.onOpenConversation} />
        </div>
        <div className="memory-view" role="tabpanel" tabIndex={0} hidden={section !== "rules"}
          id={id + "-panel-rules"} aria-labelledby={id + "-rules"}>
          <CollaborationRulesPanel scope={props.scope} />
        </div>
      </div>
    </div>
  </section>;
}

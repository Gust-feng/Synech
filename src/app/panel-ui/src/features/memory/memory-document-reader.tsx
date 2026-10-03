import { Brain } from "lucide-react";
import { RichText } from "../../components/rich-text";

/** Reading uses the same safe Markdown surface as conversation content. */
export function MemoryDocumentReader(props: {
  readonly content: string;
  readonly emptyTitle: string;
}): React.ReactElement {
  if (props.content.trim().length > 0) return <div className="memory-document-reader"><RichText text={props.content} allowImages={false} /></div>;
  return <div className="memory-document-empty">
    <div className="memory-empty-mark" aria-hidden="true"><Brain size={38} strokeWidth={1.2} /></div>
    <p>{props.emptyTitle}</p>
  </div>;
}

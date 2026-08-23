import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyActionButton } from "./copy-action-button";
import { splitStreamingMarkdownWithOffsets, stabilizeStreamingMarkdown } from "../streaming-text";
import { useStreamingText } from "../use-streaming-text";
import "../styles/rich-text.css";

export const RichText = React.memo(function RichText({ text }: { readonly text: string }): React.ReactElement {
  return (
    <div className="rich-text">
      <RichTextContent text={text} />
    </div>
  );
});

export function StreamingRichText({ text, live = true }: { readonly text: string; readonly live?: boolean }): React.ReactElement {
  // hook 必须无条件调用：run 结束瞬间 live 从 true 变 false 且实例被复用（segmentKey 不变）。
  const displayed = useStreamingText(text, live);
  if (!live) {
    return (
      <div className="rich-text">
        <RichTextContent text={text} />
      </div>
    );
  }
  const segments = splitStreamingMarkdownWithOffsets(displayed);
  return (
    <div className="rich-text rich-text-streaming">
      {segments.completedBlocks.map((block) => (
        <RichTextContent key={`block:${block.start}`} text={block.text} />
      ))}
      {segments.activeBlock.length > 0 && (
        <RichTextContent key={`active:${segments.activeStart}`} text={stabilizeStreamingMarkdown(segments.activeBlock)} />
      )}
    </div>
  );
}

const RichTextContent = React.memo(function RichTextContent({ text }: { readonly text: string }): React.ReactElement {
  return (
    <ReactMarkdown
      components={markdownComponents}
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeUrlTransform}
    >
      {normalizeMarkdownLineEndings(text)}
    </ReactMarkdown>
  );
});

function normalizeMarkdownLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function safeUrlTransform(value: string): string {
  if (/^(https?:|mailto:)/i.test(value)) {
    return value;
  }
  return "";
}

function codeLanguage(className: string | undefined): string | undefined {
  return /language-([A-Za-z0-9_-]+)/.exec(className ?? "")?.[1];
}

function preLanguage(children: React.ReactNode): string | undefined {
  const child = React.Children.toArray(children)[0];
  if (!React.isValidElement<{ readonly className?: string }>(child)) {
    return undefined;
  }
  return codeLanguage(child.props.className);
}

function markdownNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(markdownNodeText).join("");
  }
  if (React.isValidElement<{ readonly children?: React.ReactNode }>(node)) {
    return markdownNodeText(node.props.children);
  }
  return "";
}

const markdownComponents = {
  a({ children, href }) {
    if (href === undefined || href.length === 0) {
      return <span>{children}</span>;
    }
    return (
      <a className="rich-link" href={href} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  },
  blockquote({ children }) {
    return <blockquote className="rich-blockquote">{children}</blockquote>;
  },
  code({ children, className }) {
    const language = codeLanguage(className);
    return (
      <code className={language === undefined ? "rich-inline-code" : className} data-language={language}>
        {children}
      </code>
    );
  },
  h1({ children }) {
    return <h2 className="rich-heading rich-heading-1">{children}</h2>;
  },
  h2({ children }) {
    return <h2 className="rich-heading rich-heading-2">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="rich-heading rich-heading-3">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="rich-heading rich-heading-4">{children}</h4>;
  },
  hr() {
    return <hr className="rich-divider" />;
  },
  ol({ children }) {
    return <ol className="rich-list rich-list-ordered">{children}</ol>;
  },
  p({ children }) {
    return <p className="rich-paragraph">{children}</p>;
  },
  pre({ children }) {
    const language = preLanguage(children);
    const code = markdownNodeText(children).replace(/\n$/u, "");
    return (
      <div className="rich-code-frame" data-language={language}>
        <div className="rich-code-toolbar">
          <span>{language ?? "code"}</span>
          <CopyActionButton value={code} label="复制代码" className="rich-code-copy" />
        </div>
        <pre className="rich-code-block">
          {children}
        </pre>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className="rich-table-wrap">
        <table className="rich-table">{children}</table>
      </div>
    );
  },
  ul({ children }) {
    return <ul className="rich-list rich-list-unordered">{children}</ul>;
  },
} satisfies Components;
import { linkAnswerCitations } from "../../lib/answerCitations";
import type { AnswerPassage } from "../../types/sourceEvidence";
// Renders an answer as Markdown. Citations become chips: [Q3] opens that query
// in the evidence window, [C2] opens the source passage, [[id]] shows the
// individual in Explore.

import { createContext, useContext } from "react";
import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown.css";

function linkCitations(text: string): string {
  return linkAnswerCitations(text.replace(/\[\[([^\]\n]+)\]\]/g, (_m, id: string) => `[${id}](#ind-${encodeURIComponent(id)})`));
}

type CitationActions = {
  passages?: AnswerPassage[];
  onQuery?: (id: string) => void;
  onSource?: (ref: string) => void;
  onEntity?: (id: string) => void;
};
const CitationContext = createContext<CitationActions>({});

// Keep the renderer type stable: an inline component remounts every citation on
// parent updates, removing the focused button while the inspector opens/closes.
function AnswerLink({ href, children }: ComponentProps<"a">) {
  const { passages, onQuery, onSource, onEntity } = useContext(CitationContext);
  if (href?.startsWith("#cite-")) {
    const id = href.slice(6);
    return (
      <button type="button" className="cite cite-q" onClick={() => onQuery?.(id)} title={`Show query ${id}`}>
        {id}
      </button>
    );
  }
  if (href?.startsWith("#src-")) {
    const ref = href.slice(5);
    const passage = passages?.find((p) => p.ref === ref);
    if (passages && !passage) return <span className="small muted">[Source unavailable]</span>;
    return (
      <button
        type="button"
        className="cite cite-src"
        data-citation-ref={ref}
        onClick={() => onSource?.(ref)}
        aria-label={passage ? `Open source: ${passage.where}` : `Open source passage ${ref}`}
        title={passage?.where ?? "Open the source passage"}
      >
        {ref}
      </button>
    );
  }
  if (href?.startsWith("#ind-")) {
    const id = decodeURIComponent(href.slice(5));
    return (
      <button type="button" className="cite" onClick={() => onEntity?.(id)} title="Show in Explore">
        {id}
      </button>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
const components = { a: AnswerLink };

export function Markdown({ text, ...actions }: CitationActions & { text: string }) {
  return (
    <CitationContext.Provider value={actions}>
      <div className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {linkCitations(text)}
        </ReactMarkdown>
      </div>
    </CitationContext.Provider>
  );
}

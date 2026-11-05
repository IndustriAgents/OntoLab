import { useProject } from "../../app/project";
import { EmptyState, PageHead } from "../../components/ui/ui";
import { RevisionBar } from "../revisions/RevisionBar";
import { ValidationView } from "./ValidationView";
import "../workflows/workflows.css";
import "../research/research.css";
export default function ValidatePage() {
  const { pid, selectedId } = useProject();
  return (
    <div className="page-flex">
      <RevisionBar />
      <div className="page">
        <div className="page-wide">
          <PageHead title="Validation">Inspect the checks, their inputs and their results for one revision.</PageHead>
          {selectedId ? (
            <ValidationView key={selectedId} pid={pid} revisionId={selectedId} showCommit={false} />
          ) : (
            <EmptyState title="Select or create a revision to validate" />
          )}
        </div>
      </div>
    </div>
  );
}

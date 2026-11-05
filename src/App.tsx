import ExternalGraphPage from "./features/connections/ExternalGraphPage";
// Application composition: providers, workspace startup and routes. Feature pages
// live under src/features/ and are code-split per route.

import { useQuery } from "@tanstack/react-query";
import { api, qk } from "./lib/projectApi";
import { ExploreNavigation } from "./features/explore/ExploreNavigation";
import { CorpusScopeBar } from "./features/corpora/CorpusScopeBar";
import { Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./app/auth";
import { ThemeProvider } from "./app/theme";
import { ProvidersProvider } from "./app/providers";
import { EvidenceProvider } from "./features/evidence/useEvidence";
import { ProjectProvider, useProject } from "./app/project";
import { AppShell, type ProjectNavInfo } from "./app/AppShell";
import { ErrorState, LoadingState, PageErrorBoundary } from "./components/ui/ui";

const OntologyOverview = lazy(() => import("./features/ontology/OntologyOverview"));
const ActivityPage = lazy(() => import("./features/runs/ActivityPage"));
const EvaluatePage = lazy(() => import("./features/evaluate/EvaluatePage"));
const SparqlPage = lazy(() => import("./features/explore/SparqlPage"));
const CorporaPage = lazy(() => import("./features/corpora/CorporaPage"));
const CorpusPage = lazy(() => import("./features/corpora/CorpusPage"));
const ProjectsPage = lazy(() => import("./features/projects/ProjectsPage"));
const WorkflowHome = lazy(() => import("./features/workflows/WorkflowHome"));
const WorkflowPage = lazy(() => import("./features/workflows/WorkflowPage"));
const OverviewPage = lazy(() => import("./features/overview/OverviewPage"));
const OntologyPage = lazy(() => import("./features/ontology/OntologyPage"));
const DocumentsPage = lazy(() => import("./features/documents/DocumentsPage"));
const RunsPage = lazy(() => import("./features/runs/RunsPage"));
const ResearchPage = lazy(() => import("./features/research/ResearchPage"));
const ExplorePage = lazy(() => import("./features/explore/ExplorePage"));
const ValidatePage = lazy(() => import("./features/validate/ValidatePage"));
const AssistantPage = lazy(() => import("./features/assistant/AssistantPage"));
const ExportPage = lazy(() => import("./features/export/ExportPage"));
const SettingsPage = lazy(() => import("./features/settings/SettingsPage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (n, e) => n < 2 && !(e instanceof Error && /\(4\d\d\)|not found/i.test(e.message)),
      refetchOnWindowFocus: false,
    },
  },
});

function Page({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <PageErrorBoundary resetKey={pathname}>
      <Suspense fallback={<LoadingState />}>{children}</Suspense>
    </PageErrorBoundary>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.status === "loading") return <LoadingState label="Starting OntoLab…" />;
  if (auth.status === "error")
    return (
      <div className="page">
        <ErrorState title="Unable to open OntoLab" error={new Error(auth.error ?? "The server did not respond.")} onRetry={auth.retry} />
      </div>
    );
  return <>{children}</>;
}

function activityOf(state: ReturnType<typeof useProject>): Pick<ProjectNavInfo, "activity" | "activityTone"> {
  const run = state.activeRun;
  if (state.driver.error && state.driver.runId) return { activity: state.driver.error, activityTone: "error" };
  if (!run) return { activity: null };
  const total = run.steps.length;
  if (run.status === "awaiting_answers") return { activity: "Extraction needs your answers", activityTone: "attention" };
  if (state.driver.driving) return { activity: `Extracting ${Math.min(run.completedSteps + 1, total)}/${total}`, activityTone: "busy" };
  if (run.resumable) return { activity: `Run paused at ${run.completedSteps}/${total} — resume`, activityTone: "attention" };
  return { activity: `Run in progress ${run.completedSteps}/${total}`, activityTone: "busy" };
}

function ProjectLayout() {
  const state = useProject();
  const location = useLocation();
  const exploreTools = /\/(explore|assistant|sparql)$/.test(location.pathname);
  const corpus = state.project?.settings.corpus;
  const graphParent = corpus ?? state.project?.settings.externalGraph;
  const parent = useQuery({
    queryKey: qk.project(graphParent?.parentProjectId ?? "none"),
    queryFn: () => api.getProject(graphParent!.parentProjectId),
    enabled: !!graphParent,
  });
  if (state.projectError) {
    return (
      <AppShell>
        <div className="page">
          <ErrorState title="Project unavailable" error={state.projectError} />
        </div>
      </AppShell>
    );
  }
  const nav: ProjectNavInfo | undefined = state.project
    ? {
        id: state.project.id,
        name: state.project.name,
        save: state.working.save,
        flush: state.working.flush,
        saveError: state.working.saveError,
        ...(graphParent
          ? { corpus: { parentId: graphParent.parentProjectId, parentName: parent.data?.name ?? graphParent.parentName } }
          : {}),
        external: !!state.project.settings.externalGraph,
        ...activityOf(state),
      }
    : undefined;
  return (
    <AppShell project={nav}>
      <EvidenceProvider pid={state.pid} working={state.working}>
        {state.project ? (
          corpus ? (
            <div className="corpus-shell">
              {!/\/(assistant|sparql|explore)$/.test(location.pathname) && <CorpusScopeBar />}
              {exploreTools && <ExploreNavigation />}
              <Page>
                <Outlet />
              </Page>
            </div>
          ) : (
            <>
              {exploreTools && <ExploreNavigation />}
              <Page>
                <Outlet />
              </Page>
            </>
          )
        ) : (
          <LoadingState label="Opening project…" />
        )}
      </EvidenceProvider>
    </AppShell>
  );
}

function ProjectRoute() {
  const { pid } = useParams();
  return (
    <ProjectProvider key={pid} pid={pid!}>
      <ProjectLayout />
    </ProjectProvider>
  );
}

function LegacyCorpusRoute() {
  const { pid, project } = useProject();
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: `/p/${pid}/${project?.settings.corpus ? "graph" : "graphs"}`, search, hash }} replace />;
}
function GraphWorkspace() {
  const { pid, project } = useProject();
  return project?.settings.externalGraph ? (
    <ExternalGraphPage />
  ) : project?.settings.corpus ? (
    <CorpusPage />
  ) : (
    <Navigate to={`/p/${pid}/graphs`} replace />
  );
}
function ScopedExternal({ children }: { children: ReactNode }) {
  const { project } = useProject();
  return project?.settings.externalGraph ? <ExternalGraphPage /> : <>{children}</>;
}
function ParentPage({ children, path }: { children: ReactNode; path: string }) {
  const { project } = useProject();
  const { search } = useLocation();
  return project?.settings.corpus ? (
    <Navigate to={`/p/${project.settings.corpus.parentProjectId}/${path}${search}`} replace />
  ) : (
    <>{children}</>
  );
}
function ScopedDocuments() {
  const { pid, project } = useProject(),
    location = useLocation();
  const params = new URLSearchParams(location.search);
  if (params.get("run") && params.get("doc")) return <DocumentsPage />;
  params.set("tab", "documents");
  return project?.settings.corpus ? (
    <Navigate to={{ pathname: `/p/${pid}/graph`, search: `?${params}`, hash: location.hash }} replace />
  ) : params.get("doc") ? (
    <DocumentsPage />
  ) : (
    <Navigate to={`/p/${pid}/workflows/tbox?start=documents&step=sources`} replace />
  );
}
function ScopedResearch() {
  const { pid } = useProject();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  // Keep direct links to recorded files/runs usable; overview navigation is
  // consolidated into the workflow and Runs rather than another workspace.
  if (params.get("doc") || params.get("run")) return <ResearchPage />;
  return (
    <Navigate
      to={
        params.get("view") === "induction" || params.get("view") === "extraction"
          ? `/p/${pid}/runs`
          : `/p/${pid}/workflows/tbox?start=documents&step=chunks`
      }
      replace
    />
  );
}
function ScopedOntology() {
  const { pid, project, working } = useProject();
  if (!project?.settings.corpus) return <OntologyPage />;
  const pin = working.content?.corpus?.ontology;
  return pin ? (
    <Navigate
      to={`/p/${pin.projectId}/ontology?tab=review&rev=${pin.revisionId}`}
      state={{ graphReturn: { id: pid, name: project.name, to: `/p/${pid}/graph` } }}
      replace
    />
  ) : (
    <LoadingState label="Opening pinned ontology…" />
  );
}
function ScopedRuns() {
  const { pid, project } = useProject(),
    params = useParams();
  return project?.settings.corpus ? (
    <Navigate to={`/p/${pid}/graph?tab=updates${params.runId ? `&run=${params.runId}` : ""}`} replace />
  ) : (
    <RunsPage />
  );
}
function ScopedProjectSettings() {
  const { pid, project } = useProject();
  return project?.settings.corpus ? <Navigate to={`/p/${pid}/graph?tab=settings`} replace /> : <OverviewPage />;
}
function TopLevel() {
  return (
    <AppShell>
      <Page>
        <Outlet />
      </Page>
    </AppShell>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}>
          <AuthProvider>
            <Gate>
              <ProvidersProvider>
                <Routes>
                  <Route element={<TopLevel />}>
                    <Route index element={<ProjectsPage />} />
                    <Route path="settings" element={<SettingsPage />} />
                  </Route>
                  <Route path="p/:pid" element={<ProjectRoute />}>
                    <Route index element={<WorkflowHome />} />
                    <Route path="corpora" element={<LegacyCorpusRoute />} />
                    <Route path="corpus" element={<LegacyCorpusRoute />} />
                    <Route
                      path="graphs"
                      element={
                        <ParentPage path="graphs">
                          <CorporaPage />
                        </ParentPage>
                      }
                    />
                    <Route path="graph" element={<GraphWorkspace />} />
                    <Route
                      path="activity"
                      element={
                        <ParentPage path="activity">
                          <ActivityPage />
                        </ParentPage>
                      }
                    />
                    <Route
                      path="ontology/overview"
                      element={
                        <ParentPage path="ontology/overview">
                          <OntologyOverview />
                        </ParentPage>
                      }
                    />
                    <Route path="workflows/abox" element={<LegacyCorpusRoute />} />
                    <Route path="workflows/:workflow" element={<WorkflowPage />} />
                    <Route path="project-settings" element={<ScopedProjectSettings />} />
                    <Route path="ontology" element={<ScopedOntology />} />
                    <Route path="documents" element={<ScopedDocuments />} />
                    <Route path="runs" element={<ScopedRuns />} />
                    <Route path="research" element={<ScopedResearch />} />
                    <Route path="runs/:runId" element={<ScopedRuns />} />
                    <Route
                      path="explore"
                      element={
                        <ScopedExternal>
                          <ExplorePage />
                        </ScopedExternal>
                      }
                    />
                    <Route
                      path="sparql"
                      element={
                        <ScopedExternal>
                          <SparqlPage />
                        </ScopedExternal>
                      }
                    />
                    <Route path="validate" element={<ValidatePage />} />
                    <Route path="evaluate" element={<EvaluatePage />} />
                    <Route path="assistant" element={<AssistantPage />} />
                    <Route
                      path="export"
                      element={
                        <ScopedExternal>
                          <ExportPage />
                        </ScopedExternal>
                      }
                    />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </ProvidersProvider>
            </Gate>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

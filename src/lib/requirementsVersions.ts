import type { Project, Requirements, RequirementsVersion, ExtractionRun } from "../types/project";

export function projectRequirements(project: Project): Requirements {
  if (project.settings.requirements) return project.settings.requirements;
  const queries = new Map((project.settings.savedQueries ?? []).map((q) => [q.question, q.sparql]));
  return {
    stories: [],
    cqs: project.competencyQuestions.map((text, i) => ({
      id: `legacy-${i}`,
      text,
      status: "approved",
      source: "user",
      ...(queries.get(text) ? { sparql: queries.get(text) } : {}),
    })),
  };
}

/** Analysis can be refreshed without changing the questions or their saved version. */
export function requirementsIdentity(requirements: Requirements): string {
  return JSON.stringify({
    stories: requirements.stories,
    cqs: requirements.cqs.map((q) => ({
      id: q.id,
      text: q.text,
      status: q.status,
      source: q.source,
      story: q.story,
      sparql: q.sparql,
    })),
  });
}

export function requirementsHistory(project: Project): RequirementsVersion[] {
  if (project.settings.requirementsVersions?.length) return project.settings.requirementsVersions;
  const requirements = projectRequirements(project);
  return requirements.stories.length || requirements.cqs.length ? [{ number: 1, createdAt: project.updatedAt, requirements }] : [];
}

/** Freeze the project context used by induction, including on retry/resume. */
export function projectForBuild(project: Project, run: ExtractionRun): Project {
  const snapshot = run.requirementsSnapshot;
  if (!snapshot) return project;
  return {
    ...project,
    purpose: snapshot.purpose,
    scope: snapshot.scope,
    competencyQuestions: snapshot.requirements.cqs.filter((q) => q.status === "approved").map((q) => q.text),
    settings: { ...project.settings, requirements: snapshot.requirements },
  };
}

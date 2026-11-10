import AgentConnectionsSettings from "../agent/ConnectionsSettings";
import ConnectionsSettings from "../connections/ConnectionsSettings";
import ModelEndpointsSettings from "./ModelEndpointsSettings";
import ProjectsPage from "../projects/ProjectsPage";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { useAuth } from "../../app/auth";
import { useModelChoice, selectProps } from "../../app/providers";
import { accountInitials, getSettingsSection } from "../../app/settingsNavigation";
import { providerGroups } from "../../lib/providerGroups";
import { useTheme } from "../../app/theme";
import { api, qk } from "../../lib/projectApi";
import { fmtSize } from "../../lib/format";
import { ProviderModelSelect } from "../../components/common/ProviderModelSelect";
import { IconCheck, IconMoon, IconSun } from "../../components/icons";
import { ErrorState, PageHead, StatusBadge } from "../../components/ui/ui";

export default function SettingsPage() {
  const auth = useAuth();
  const choice = useModelChoice();
  const { theme, toggle } = useTheme();
  const { search } = useLocation();
  const section = getSettingsSection(search);
  const usage = useQuery({ queryKey: qk.usage, queryFn: api.usage, enabled: section.id === "storage" });
  const pct = usage.data ? Math.min(100, Math.round((usage.data.usedBytes / usage.data.quotaBytes) * 100)) : 0;
  const limits = auth.config?.limits;
  const name = "This computer";

  return (
    <div className="page settings-page">
      <div className="page-narrow settings-content">
        {section.id !== "projects" && <PageHead title={section.label}>{section.description}</PageHead>}

        {section.id === "projects" && <ProjectsPage embedded />}
        {section.id === "connections" && <ConnectionsSettings />}
        {section.id === "account" && (
          <section className="card settings-card" aria-label="Account details">
            <div className="settings-profile">
              <span className="account-avatar settings-avatar" aria-hidden="true">
                {accountInitials(name)}
              </span>
              <div className="settings-profile-text">
                <h2>{name}</h2>
                <p>Your personal OntoLab workspace</p>
              </div>
              <StatusBadge tone="muted">Local workspace</StatusBadge>
            </div>
            <div className="settings-row">
              <div>
                <h3>Workspace access</h3>
                <p>A single-user workspace. No sign-in is required.</p>
              </div>
            </div>
            <div className="settings-note">Your projects and preferences are available in this workspace.</div>
          </section>
        )}

        {section.id === "ai-connections" && <AgentConnectionsSettings />}

        {section.id === "appearance" && (
          <section className="card settings-card" aria-labelledby="st-theme">
            <div className="settings-section-head">
              <h2 id="st-theme">Color theme</h2>
              <p>Choose the look you prefer. Your choice is saved in this browser.</p>
            </div>
            <div className="theme-options" role="group" aria-label="Color theme">
              {(["light", "dark"] as const).map((option) => (
                <button
                  key={option}
                  className={"theme-option" + (theme === option ? " is-selected" : "")}
                  aria-pressed={theme === option}
                  onClick={() => {
                    if (theme !== option) toggle();
                  }}
                >
                  <span className={`theme-preview theme-preview-${option}`} aria-hidden="true">
                    <span className="theme-preview-sidebar">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="theme-preview-content">
                      <i />
                      <i />
                      <span />
                    </span>
                  </span>
                  <span className="theme-option-label">
                    {option === "light" ? <IconSun /> : <IconMoon />}
                    <span>{option === "light" ? "Light" : "Dark"}</span>
                    {theme === option && <IconCheck className="theme-selected-icon" />}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {section.id === "providers" && (
          <>
            <section className="card settings-card" aria-labelledby="st-models">
              <div className="settings-section-head">
                <h2 id="st-models">Connected providers</h2>
                <p>Models available to this workspace.</p>
              </div>
              {choice.status === "error" ? (
                <ErrorState error={new Error(choice.error ?? "Could not load providers")} onRetry={choice.reload} />
              ) : choice.status === "loading" ? (
                <p className="muted" role="status">
                  Loading providers…
                </p>
              ) : (
                <div className="settings-provider-groups">
                  {providerGroups(choice.providers, window.location.hostname).map((group) => (
                    <section key={group.id} className="settings-provider-group" aria-label={group.label}>
                      <div className="settings-provider-group-head">
                        <h3>{group.label}</h3>
                        <p>
                          {group.id === "cli"
                            ? "Installed on this computer. Uses your CLI login and account quota."
                            : "Models accessed through their configured APIs."}
                        </p>
                      </div>
                      <ul className="provider-list settings-provider-list">
                        {group.providers.map((p) => (
                          <li key={p.id}>
                            <span className="settings-provider-name">
                              <strong>{p.label}</strong>
                              {p.supportsVision && <small>Supports PDF images</small>}
                              {p.disabledReason && <small>{p.disabledReason}</small>}
                            </span>
                            {p.enabled ? (
                              <StatusBadge tone="ok">{p.kind === "cli" ? "Installed · login unchecked" : "Available"}</StatusBadge>
                            ) : (
                              <StatusBadge tone="muted">{p.kind === "cli" ? "Unavailable" : "Not configured"}</StatusBadge>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
              <p className="field-hint">
                {choice.providers.some((p) => p.kind === "cli")
                  ? "API keys and CLI logins are managed on this computer. API dollar estimates do not apply to CLI runs."
                  : "API providers use this computer’s configuration. Usage is billed by each provider where applicable."}
              </p>
            </section>
            <ModelEndpointsSettings onChange={choice.reload} />
            <section className="card settings-card" aria-labelledby="st-default">
              <div className="settings-section-head">
                <h2 id="st-default">Default model</h2>
                <p>Your starting model for new work. You can change it for each run.</p>
              </div>
              <ProviderModelSelect {...selectProps(choice)} structuredOnly />
            </section>
          </>
        )}

        {section.id === "storage" && (
          <section className="card settings-card" aria-labelledby="st-storage">
            <div className="settings-section-head">
              <h2 id="st-storage">Workspace storage</h2>
              <p>Space used by your projects and documents.</p>
            </div>
            {usage.error ? (
              <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
            ) : usage.data ? (
              <div className="settings-storage-summary">
                <div className="settings-storage-total">
                  <span>
                    <strong>{fmtSize(usage.data.usedBytes)}</strong> of {fmtSize(usage.data.quotaBytes)} used
                  </span>
                  <span>{pct}%</span>
                </div>
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  aria-label="Storage used"
                >
                  <div className={"progress-bar" + (pct > 90 ? " alert" : pct > 75 ? " warn" : "")} style={{ width: `${pct}%` }} />
                </div>
                <p className="muted small">
                  {usage.data.projects} project{usage.data.projects === 1 ? "" : "s"} · {usage.data.documents} document
                  {usage.data.documents === 1 ? "" : "s"}
                </p>
              </div>
            ) : (
              <p className="muted" role="status">
                Loading storage usage…
              </p>
            )}
            {limits && (
              <dl className="settings-limits">
                <div>
                  <dt>Maximum file size</dt>
                  <dd>{fmtSize(limits.maxFileBytes)}</dd>
                </div>
                <div>
                  <dt>Documents per project</dt>
                  <dd>{limits.maxDocumentsPerProject}</dd>
                </div>
                <div>
                  <dt>Nodes per graph view</dt>
                  <dd>{limits.maxGraphNodes}</dd>
                </div>
              </dl>
            )}
            <div className="settings-row">
              <p>Need more space? Export old projects as archives before deleting them.</p>
              <Link className="btn ghost sm" to="/">
                View projects
              </Link>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

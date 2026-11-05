import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { IconClose } from "../components/icons";
import { getSettingsSection, SETTINGS_SECTIONS } from "./settingsNavigation";

export function SettingsLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const section = getSettingsSection(location.search);
  const state = location.state as { settingsReturnTo?: string } | null;
  const returnTo = state?.settingsReturnTo ?? "/";

  return (
    <div className="settings-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="settings-topbar">
        <Link to={returnTo} className="brand" aria-label="OntoLab — return to workspace">
          <span className="brand-name">
            onto<span>lab</span>
          </span>
        </Link>
        <Link to={returnTo} className="settings-close">
          <span>Close settings</span>
          <IconClose />
        </Link>
      </header>
      <main id="main" className="settings-main" tabIndex={-1}>
        <div className="settings-frame">
          <div className="settings-title">Settings</div>
          <nav className="settings-tabs" aria-label="Settings">
            {SETTINGS_SECTIONS.map((item) => (
              <Link
                key={item.id}
                to={`/settings?section=${item.id}`}
                state={state}
                className={"settings-tab" + (item.id === section.id ? " is-active" : "")}
                aria-current={item.id === section.id ? "page" : undefined}
              >
                <item.icon />
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
          {children}
        </div>
      </main>
    </div>
  );
}

import { IconFolder, IconSettings, IconShield, IconSpark, IconSun } from "../components/icons";

export const SETTINGS_SECTIONS = [
  { id: "projects", label: "Projects", description: "Create and manage your ontology workspaces.", icon: IconFolder },
  { id: "account", label: "Account", description: "Your profile and workspace access.", icon: IconShield },
  { id: "appearance", label: "Appearance", description: "Make OntoLab feel at home.", icon: IconSun },
  { id: "providers", label: "AI providers", description: "Choose models for OntoLab answers and extraction.", icon: IconSpark },
  { id: "ai-connections", label: "AI connections", description: "Give an external assistant access to OntoLab projects.", icon: IconSpark },
  { id: "connections", label: "Graph connections", description: "Connect your RDF and Neo4j databases.", icon: IconSettings },
  { id: "storage", label: "Storage", description: "Workspace usage and upload limits.", icon: IconSettings },
] as const;

export function getSettingsSection(search: string) {
  const id = new URLSearchParams(search).get("section");
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS.find((s) => s.id === "account")!;
}

export const accountInitials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("") || "?";

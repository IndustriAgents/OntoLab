export default {
  learn: [
    {
      type: "category",
      label: "Start here",
      collapsed: false,
      items: ["start/introduction", "start/quickstart", "start/first-project", "start/glossary"],
    },
    { type: "category", label: "Workflows", collapsed: false, items: ["guides/build-tbox", "guides/extract-abox", "guides/align-merge"] },
    {
      type: "category",
      label: "Work with your project",
      items: [
        "guides/documents",
        "guides/review",
        "guides/manual-editing",
        "guides/ask",
        "guides/evaluate",
        "guides/local-ai",
        "guides/graph-connections",
        "guides/export",
      ],
    },
    {
      type: "category",
      label: "Understand OntoLab",
      items: ["concepts/knowledge-graphs", "concepts/requirements", "concepts/revisions", "concepts/validation"],
    },
    "help/troubleshooting",
  ],
  reference: [
    "reference/availability",
    "reference/formats",
    "reference/settings",
    "reference/validation-messages",
    "reference/integrations",
    "reference/releases",
  ],
  research: ["research/methods", "research/experiments", "research/evaluation"],
  developers: ["developers/local-setup", "developers/architecture", "developers/api", "developers/deployment", "developers/contributing"],
};

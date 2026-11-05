const bundled = process.env.ONTOLAB_BUNDLED_DOCS === "1";
const appBase = (process.env.ONTOLAB_DOCS_APP_BASE ?? "").replace(/\/+$/, "");
const config = {
  title: "OntoLab",
  tagline: "From source documents to knowledge you can inspect.",
  favicon: "img/logo.svg",
  url: bundled ? "http://localhost" : "http://localhost:8788",
  baseUrl: bundled ? `${appBase}/docs/` : "/ontolab/",
  customFields: { bundledDocs: bundled, appVersion: process.env.ONTOLAB_DOCS_VERSION ?? "" },
  trailingSlash: true,
  onBrokenLinks: "throw",
  markdown: { hooks: { onBrokenMarkdownLinks: "throw" } },
  organizationName: "IndustriAgents",
  projectName: "OntoLab",
  presets: [
    [
      "classic",
      {
        docs: { routeBasePath: "/", sidebarPath: "./sidebars.js", showLastUpdateTime: false },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
        sitemap: bundled ? false : { changefreq: "weekly", priority: 0.5 },
      },
    ],
  ],
  themeConfig: {
    image: "img/social-card.svg",
    colorMode: { defaultMode: "light", respectPrefersColorScheme: true },
    navbar: {
      title: "ontolab",
      logo: { alt: "OntoLab document and knowledge graph symbol", src: "img/logo.svg" },
      items: [
        { type: "docSidebar", sidebarId: "learn", label: "Learn", position: "left" },
        { type: "docSidebar", sidebarId: "reference", label: "Reference", position: "left" },
        { type: "docSidebar", sidebarId: "research", label: "Research", position: "left" },
        { type: "docSidebar", sidebarId: "developers", label: "Developers", position: "left" },
        { type: "search", position: "right" },
        bundled
          ? { type: "custom-workspaceLink", position: "right" }
          : { to: "/developers/local-setup", label: "Run OntoLab locally", position: "right", className: "navbar-app-link" },
      ],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Start exploring",
          items: [
            { label: "Your first knowledge graph", to: "/start/quickstart" },
            { label: "Key concepts", to: "/concepts/knowledge-graphs" },
          ],
        },
        {
          title: "Go further",
          items: [
            { label: "Research & methods", to: "/research/methods" },
            { label: "Troubleshooting", to: "/help/troubleshooting" },
            { label: "Release notes", to: "/reference/releases" },
          ],
        },
        {
          title: "IndustriAgents",
          items: [
            ...(bundled
              ? [{ label: "Back to workspace", href: `${appBase}/` }]
              : [{ label: "Run OntoLab locally", to: "/developers/local-setup" }]),
          ],
        },
      ],
      copyright: bundled
        ? `OntoLab ${process.env.ONTOLAB_DOCS_VERSION ?? ""} · Bundled documentation · Available offline`
        : "© IndustriAgents · OntoLab documentation",
    },
    prism: { additionalLanguages: ["bash", "json", "sql", "turtle"] },
    tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
  },
};
export default config;

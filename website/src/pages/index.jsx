import React from "react";
import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";
import useBaseUrl from "@docusaurus/useBaseUrl";

const paths = [
  [
    "01",
    "Start with the sample",
    "Follow a technical manual from its source text to a graph you can question and export.",
    "/start/quickstart",
    "Explore the walkthrough",
  ],
  [
    "02",
    "Build from your documents",
    "Define your questions, build an ontology and extract knowledge with evidence attached.",
    "/start/first-project",
    "Create your first project",
  ],
  [
    "03",
    "Bring an existing ontology",
    "Import your schema or compare standards, review matches and merge with confidence.",
    "/guides/align-merge",
    "Work with your ontology",
  ],
];
export default function Home() {
  return (
    <Layout
      title="Documentation"
      description="Learn to build, review and query evidence-backed knowledge graphs with OntoLab. Tutorials, workflow guides, research methods and developer reference."
    >
      <main className="docs-home">
        <section className="docs-hero">
          <div className="hero-copy">
            <p className="eyebrow">OntoLab documentation</p>
            <h1>
              Documents.
              <br />
              Knowledge.
              <br />
              <span>Connected.</span>
            </h1>
            <p className="hero-description">
              Turn source documents into a knowledge graph you can inspect, improve and use. Learn every step, from the first question to
              the final evidence.
            </p>
            <div className="hero-actions">
              <Link className="button button--primary" to="/start/quickstart">
                Build your first graph <span aria-hidden="true">↗</span>
              </Link>
              <Link className="hero-secondary" to="/start/introduction">
                Meet OntoLab →
              </Link>
            </div>
            <p className="hero-note">A practical guide for domain experts, researchers and builders.</p>
          </div>
          <div className="hero-illustration">
            <img
              src={useBaseUrl("/img/workflow.svg")}
              alt="Documents flow into an ontology, then into connected individuals with source evidence."
            />
            <div className="diagram-caption">
              <span className="status-dot" /> Source → schema → evidence → graph
            </div>
          </div>
        </section>
        <section className="start-section" aria-labelledby="choose-path">
          <div className="section-heading">
            <h2 id="choose-path">Find your starting point</h2>
            <span>Three ways to start</span>
          </div>
          <div className="path-grid">
            {paths.map(([n, title, desc, to, label]) => (
              <Link className="path-card" to={to} key={n}>
                <span className="card-number">
                  {n} <span aria-hidden="true">↗</span>
                </span>
                <h3>{title}</h3>
                <p>{desc}</p>
                <strong>
                  {label} <span aria-hidden="true">→</span>
                </strong>
              </Link>
            ))}
          </div>
        </section>
        <section className="docs-shelf">
          <div>
            <p className="eyebrow">A workspace you can understand</p>
            <h2>
              See how the knowledge
              <br />
              was made.
            </h2>
            <p>Review quotations, inspect each run and validate your changes. OntoLab keeps the path from source to assertion visible.</p>
            <Link to="/concepts/knowledge-graphs">Understand the concepts →</Link>
          </div>
          <div className="shelf-links">
            <Link to="/guides/build-tbox">
              <span>01 / WORKFLOW</span>
              <strong>Build T-Box</strong>
              <small>Classes, properties and logical rules ↗</small>
            </Link>
            <Link to="/guides/extract-abox">
              <span>02 / WORKFLOW</span>
              <strong>Extract A-Box</strong>
              <small>Individuals, relationships and evidence ↗</small>
            </Link>
            <Link to="/research/experiments">
              <span>03 / INSPECTION</span>
              <strong>Look inside a run</strong>
              <small>Methods, parameters and recorded results ↗</small>
            </Link>
          </div>
        </section>
        <section className="help-strip">
          <div>
            <h2>Need a specific answer?</h2>
            <p>Find supported formats, understand a warning or get a run moving again.</p>
          </div>
          <Link to="/help/troubleshooting">Visit troubleshooting →</Link>
        </section>
      </main>
    </Layout>
  );
}

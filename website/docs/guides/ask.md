---
title: "Ask the knowledge graph"
description: "Use graph chat and inspect the queries and source passages behind an answer."
---

**Ask** answers from the selected graph version using read-only graph queries and document search. Connected RDF databases and Neo4j can also provide a scoped graph backend.

## Ask a focused question

1. Open **Knowledge graphs → Explore → Ask**. Check the graph version shown in the heading.
2. Open the model name below the message field to select an available provider/model with tool-calling support.
3. Ask a specific question, such as “Which sensors belong to the distributing station?”
4. Watch the streamed steps and inspect the final answer.

Questions about counts and relationships depend on what the graph contains. An empty answer may mean the graph is incomplete, not that the real-world answer is empty.

## Read citations

Query citations appear as **[Q1]**, **[Q2]** and so on. Source passages appear as **[C1]**, **[C2]**. Open a query citation, **View evidence** below an answer, or **Show evidence** in the heading to inspect its recorded evidence. The panel shows the evidence graph, queries, results, answer and trace. Inspect the actual query and rows before trusting a count or list.

For some aggregate queries, OntoLab runs an additional expansion query to show the triples behind the answer. Saved conversations keep the recorded queries, trace and evidence for later inspection.

Open a source citation to inspect its passage in the same panel. The source inspector offers **Source**, **Model input**, and **History**, with recorded checks kept separate from human review. **Back to answer evidence** restores the answer's queries and results. Query evidence without a recorded source association does not imply a document citation.

## Return to a conversation

Open **History** to search previous conversations or start a new one. Selecting a conversation restores its messages and recorded evidence. While an answer is being produced, finish or stop it before switching conversations.

## Query with SPARQL

Open the **SPARQL** tab beside Ask to query a built-in graph directly. Choose the graph version, write a SELECT or ASK query, or load one of the examples. **Run query** or **⌘/Ctrl + Enter** executes it without modifying the graph.

Results appear in a table with pagination and a **Download CSV** action. Editing the query does not rerun it; a notice identifies results from the previous query. No matching rows and query failures have separate explanations. Queries use the chosen version’s saved fact review policy and ontology, so proposed or rejected facts may be excluded.

## Know the boundary

Graph chat is read-only. The built-in project graph accepts SELECT and ASK queries, not updates. **Propose changes** is a separate draft-producing operation that still requires review and a commit.

Tool rounds are bounded. A failure or partial answer should be interpreted with its trace. Provider availability and GraphDB support depend on the installation; consult [integrations](../reference/integrations.md).

## Improve an answer

Check that you selected the intended committed revision, the necessary facts were extracted and accepted, and the question matches the ontology’s terms. Correct the graph or requirements when needed rather than treating repeated prompting as a substitute for missing data.

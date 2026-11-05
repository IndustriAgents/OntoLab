package ontolab.reasoner;

import org.semanticweb.HermiT.ReasonerFactory;
import org.semanticweb.owl.explanation.api.Explanation;
import org.semanticweb.owl.explanation.api.ExplanationGenerator;
import org.semanticweb.owl.explanation.api.ExplanationGeneratorFactory;
import org.semanticweb.owl.explanation.api.ExplanationManager;
import org.semanticweb.owlapi.apibinding.OWLManager;
import org.semanticweb.owlapi.io.StringDocumentSource;
import org.semanticweb.owlapi.manchestersyntax.renderer.ManchesterOWLSyntaxOWLObjectRendererImpl;
import org.semanticweb.owlapi.model.*;
import org.semanticweb.owlapi.reasoner.InferenceType;
import org.semanticweb.owlapi.reasoner.OWLReasoner;
import org.semanticweb.owlapi.reasoner.OWLReasonerFactory;
import org.semanticweb.owlapi.reasoner.SimpleConfiguration;

import java.util.*;
import java.util.concurrent.*;

/** One reasoning request: load, check, classify, explain; report as ReasonerReport JSON. */
final class Reasoning {
  static final class BadInput extends Exception {
    BadInput(String message) {
      super(message);
    }
  }

  private static final String THING = "http://www.w3.org/2002/07/owl#Thing";
  private static final String NOTHING = "http://www.w3.org/2002/07/owl#Nothing";

  private final App.Request req;
  private final long timeoutMs;
  private final OWLOntologyManager manager = OWLManager.createOWLOntologyManager();
  private final OWLDataFactory df = manager.getOWLDataFactory();
  /** axiom (without annotations) -> module it came from */
  private final Map<OWLAxiom, String> origin = new HashMap<>();
  private final Set<OWLAxiom> aboxAxioms = new HashSet<>();
  private final ManchesterOWLSyntaxOWLObjectRendererImpl renderer = new ManchesterOWLSyntaxOWLObjectRendererImpl();
  private final List<String> incomplete = new ArrayList<>();

  Reasoning(App.Request req, long timeoutMs) {
    this.req = req;
    this.timeoutMs = timeoutMs;
  }

  Map<String, Object> run() throws Exception {
    long started = System.currentTimeMillis();
    OWLOntology merged = manager.createOntology(IRI.create("urn:ontolab:merged"));
    for (App.Module m : req.modules) load(m.name, m.turtle, merged, false);
    if (req.abox != null && !req.abox.isBlank()) load("abox", req.abox, merged, true);
    if ("elk".equalsIgnoreCase(req.reasoner)) incomplete.add("ELK is not bundled in this sidecar; HermiT was used");

    OWLReasonerFactory factory = new ReasonerFactory();
    OWLReasoner reasoner = factory.createReasoner(merged, new SimpleConfiguration(timeoutMs));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("tier", "dl");
    out.put("reasoner", "hermit");
    List<Map<String, Object>> clashes = new ArrayList<>();
    List<Map<String, Object>> unsat = new ArrayList<>();
    List<Map<String, Object>> subsumptions = new ArrayList<>();
    List<Map<String, Object>> propertySubsumptions = new ArrayList<>();
    Map<String, List<String>> inferredTypes = new LinkedHashMap<>();
    boolean wantExplain = req.tasks == null || req.tasks.contains("explain");
    int maxExpl = Math.max(0, Math.min(50, req.maxExplanations));

    boolean consistent = reasoner.isConsistent();
    out.put("consistent", consistent);
    if (!consistent) {
      OWLAxiom entailment = df.getOWLSubClassOfAxiom(df.getOWLThing(), df.getOWLNothing());
      List<Map<String, Object>> explanation = wantExplain ? explain(factory, merged, entailment) : List.of();
      Set<String> subjects = new LinkedHashSet<>();
      for (Map<String, Object> a : explanation) if (a.get("individualId") != null) subjects.add((String) a.get("individualId"));
      Map<String, Object> clash = new LinkedHashMap<>();
      clash.put("code", "inconsistent");
      clash.put("message", "The ontology and its data contradict each other: no interpretation satisfies all of the axioms below.");
      clash.put("subjects", new ArrayList<>(subjects));
      clash.put("explanation", explanation);
      clashes.add(clash);
      incomplete.add("Classification and unsatisfiable classes are not computed for an inconsistent ontology");
    } else {
      reasoner.precomputeInferences(InferenceType.CLASS_HIERARCHY, InferenceType.OBJECT_PROPERTY_HIERARCHY, InferenceType.CLASS_ASSERTIONS);
      int explained = 0;
      for (OWLClass c : reasoner.getUnsatisfiableClasses().getEntitiesMinusBottom()) {
        Map<String, Object> u = new LinkedHashMap<>();
        u.put("cls", c.getIRI().toString());
        u.put("reason", "HermiT proves it can have no members");
        u.put("explanation", wantExplain && explained++ < maxExpl ? explain(factory, merged, df.getOWLSubClassOfAxiom(c, df.getOWLNothing())) : List.of());
        unsat.add(u);
      }
      for (OWLClass c : merged.getClassesInSignature()) {
        if (c.isOWLThing() || c.isOWLNothing()) continue;
        for (OWLClass sup : reasoner.getSuperClasses(c, false).getFlattened()) {
          String s = sup.getIRI().toString();
          if (s.equals(THING) || s.equals(NOTHING)) continue;
          subsumptions.add(Map.of("kind", "subClassOf", "args", List.of(c.getIRI().toString(), s)));
        }
        for (OWLClass eq : reasoner.getEquivalentClasses(c).getEntitiesMinus(c)) {
          if (eq.isOWLNothing() || eq.isOWLThing()) continue;
          subsumptions.add(Map.of("kind", "subClassOf", "args", List.of(c.getIRI().toString(), eq.getIRI().toString())));
        }
      }
      for (OWLObjectProperty p : merged.getObjectPropertiesInSignature()) {
        if (p.isOWLTopObjectProperty()) continue;
        for (OWLObjectPropertyExpression sup : reasoner.getSuperObjectProperties(p, false).getFlattened()) {
          if (sup.isAnonymous() || sup.isOWLTopObjectProperty()) continue;
          propertySubsumptions.add(Map.of("kind", "subPropertyOf", "args", List.of(p.getIRI().toString(), sup.asOWLObjectProperty().getIRI().toString())));
        }
      }
      for (OWLNamedIndividual ind : merged.getIndividualsInSignature()) {
        Set<String> asserted = new HashSet<>();
        for (OWLClassAssertionAxiom ax : merged.getClassAssertionAxioms(ind)) if (!ax.getClassExpression().isAnonymous()) asserted.add(ax.getClassExpression().asOWLClass().getIRI().toString());
        List<String> extra = new ArrayList<>();
        for (OWLClass t : reasoner.getTypes(ind, false).getFlattened()) {
          String s = t.getIRI().toString();
          if (!s.equals(THING) && !asserted.contains(s)) extra.add(s);
        }
        if (!extra.isEmpty()) {
          Collections.sort(extra);
          inferredTypes.put(ind.getIRI().toString(), extra);
        }
      }
    }
    reasoner.dispose();

    out.put("clashes", clashes);
    out.put("unsatisfiable", unsat);
    out.put("subsumptions", subsumptions);
    out.put("propertySubsumptions", propertySubsumptions);
    out.put("inferredTypes", inferredTypes);
    out.put("inferredLinks", List.of());
    out.put("sameAs", List.of());
    incomplete.add("Inferred property assertions and owl:sameAs groups are not reported by the DL tier");
    out.put("incomplete", incomplete);
    out.put("stats", Map.of("axioms", merged.getLogicalAxiomCount(), "facts", 0, "ms", System.currentTimeMillis() - started));
    return out;
  }

  private void load(String name, String turtle, OWLOntology merged, boolean abox) throws BadInput {
    OWLOntologyManager m = OWLManager.createOWLOntologyManager();
    // never fetch owl:imports from the web: every module the user has is sent in the request
    OWLOntologyLoaderConfiguration cfg = new OWLOntologyLoaderConfiguration()
        .setMissingImportHandlingStrategy(MissingImportHandlingStrategy.SILENT)
        .setConnectionTimeout(1);
    OWLOntology o;
    try {
      o = m.loadOntologyFromOntologyDocument(new StringDocumentSource(turtle == null ? "" : turtle), cfg);
    } catch (OWLOntologyCreationException e) {
      throw new BadInput(name + ": " + e.getMessage());
    }
    for (OWLAxiom ax : o.getAxioms()) {
      if (!(ax.isLogicalAxiom() || ax instanceof OWLDeclarationAxiom)) continue;
      manager.addAxiom(merged, ax);
      OWLAxiom key = ax.getAxiomWithoutAnnotations();
      origin.putIfAbsent(key, name);
      if (abox) aboxAxioms.add(key);
    }
  }

  /** The asserted axioms behind an entailment (one justification), bounded in time. */
  private List<Map<String, Object>> explain(OWLReasonerFactory factory, OWLOntology ontology, OWLAxiom entailment) {
    ExecutorService pool = Executors.newSingleThreadExecutor();
    try {
      Future<Set<Explanation<OWLAxiom>>> f = pool.submit(() -> {
        ExplanationGeneratorFactory<OWLAxiom> gf = ExplanationManager.createExplanationGeneratorFactory(factory, OWLManager::createOWLOntologyManager);
        ExplanationGenerator<OWLAxiom> gen = gf.createExplanationGenerator(ontology);
        return gen.getExplanations(entailment, 1);
      });
      Set<Explanation<OWLAxiom>> found = f.get(Math.max(1000, timeoutMs / 4), TimeUnit.MILLISECONDS);
      if (found.isEmpty()) return List.of();
      List<Map<String, Object>> out = new ArrayList<>();
      int i = 0;
      for (OWLAxiom ax : found.iterator().next().getAxioms()) out.add(axiomJson(ax, i++));
      return out;
    } catch (TimeoutException e) {
      incomplete.add("An explanation timed out");
      return List.of();
    } catch (Exception e) {
      incomplete.add("An explanation could not be computed: " + e.getClass().getSimpleName());
      return List.of();
    } finally {
      pool.shutdownNow();
    }
  }

  /** An OWL API axiom in the shared Axiom JSON shape (best effort; anything else is "other"). */
  private Map<String, Object> axiomJson(OWLAxiom ax, int i) {
    Map<String, Object> a = new LinkedHashMap<>();
    a.put("id", "d" + i);
    String kind = "other";
    List<String> args = null;
    if (ax instanceof OWLSubClassOfAxiom s && !s.getSubClass().isAnonymous() && !s.getSuperClass().isAnonymous()) {
      kind = "subClassOf";
      args = List.of(iri(s.getSubClass().asOWLClass()), iri(s.getSuperClass().asOWLClass()));
    } else if (ax instanceof OWLDisjointClassesAxiom d && d.getClassExpressions().size() == 2 && d.getClassExpressions().stream().noneMatch(OWLClassExpression::isAnonymous)) {
      kind = "disjointWith";
      args = d.getClassExpressions().stream().map(c -> iri(c.asOWLClass())).sorted().toList();
    } else if (ax instanceof OWLEquivalentClassesAxiom e && e.getClassExpressions().size() == 2 && e.getClassExpressions().stream().noneMatch(OWLClassExpression::isAnonymous)) {
      kind = "equivalentClass";
      args = e.getClassExpressions().stream().map(c -> iri(c.asOWLClass())).sorted().toList();
    } else if (ax instanceof OWLObjectPropertyDomainAxiom d && !d.getProperty().isAnonymous() && !d.getDomain().isAnonymous()) {
      kind = "domain";
      args = List.of(d.getProperty().asOWLObjectProperty().getIRI().toString(), iri(d.getDomain().asOWLClass()));
    } else if (ax instanceof OWLDataPropertyDomainAxiom d && !d.getDomain().isAnonymous()) {
      kind = "domain";
      args = List.of(d.getProperty().asOWLDataProperty().getIRI().toString(), iri(d.getDomain().asOWLClass()));
    } else if (ax instanceof OWLObjectPropertyRangeAxiom r && !r.getProperty().isAnonymous() && !r.getRange().isAnonymous()) {
      kind = "range";
      args = List.of(r.getProperty().asOWLObjectProperty().getIRI().toString(), iri(r.getRange().asOWLClass()));
    } else if (ax instanceof OWLClassAssertionAxiom c && !c.getClassExpression().isAnonymous() && c.getIndividual().isNamed()) {
      kind = "type";
      args = List.of(c.getIndividual().asOWLNamedIndividual().getIRI().toString(), iri(c.getClassExpression().asOWLClass()));
    } else if (ax instanceof OWLObjectPropertyAssertionAxiom p && !p.getProperty().isAnonymous() && p.getSubject().isNamed() && p.getObject().isNamed()) {
      kind = "link";
      args = List.of(p.getSubject().asOWLNamedIndividual().getIRI().toString(), p.getProperty().asOWLObjectProperty().getIRI().toString(), p.getObject().asOWLNamedIndividual().getIRI().toString());
    } else if (ax instanceof OWLFunctionalObjectPropertyAxiom f && !f.getProperty().isAnonymous()) {
      kind = "functional";
      args = List.of(f.getProperty().asOWLObjectProperty().getIRI().toString());
    }
    if (args == null) args = List.of(renderer.render(ax));
    a.put("kind", kind);
    a.put("args", args);
    OWLAxiom key = ax.getAxiomWithoutAnnotations();
    if (aboxAxioms.contains(key)) {
      ax.getIndividualsInSignature().stream().findFirst().ifPresent(ind -> a.put("individualId", ind.getIRI().toString()));
    } else if (origin.containsKey(key)) {
      a.put("module", origin.get(key));
    }
    return a;
  }

  private static String iri(OWLClass c) {
    return c.getIRI().toString();
  }
}

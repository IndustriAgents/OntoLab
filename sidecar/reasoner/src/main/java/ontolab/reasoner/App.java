package ontolab.reasoner;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.Javalin;
import io.javalin.http.Context;

import java.util.List;
import java.util.Map;

/**
 * OntoLab DL reasoner sidecar. POST /reason with the ontology modules (Turtle)
 * and, optionally, the A-Box (Turtle); answers in the same JSON shape as the
 * in-process OWL 2 RL engine (ReasonerReport), so the Node server can swap tiers.
 */
public final class App {
  static final ObjectMapper JSON = new ObjectMapper();

  /** Request body of POST /reason. */
  public static final class Request {
    public List<Module> modules = List.of();
    public String abox = "";
    public String reasoner = "hermit";
    public List<String> tasks = List.of("consistency", "unsat", "classify", "explain");
    public int maxExplanations = 10;
  }

  public static final class Module {
    public String name = "module.ttl";
    public String turtle = "";
  }

  public static void main(String[] args) {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8091"));
    String token = System.getenv().getOrDefault("REASONER_TOKEN", "");
    long maxBytes = Long.parseLong(System.getenv().getOrDefault("MAX_BODY_BYTES", String.valueOf(50L * 1024 * 1024)));
    long timeoutMs = Long.parseLong(System.getenv().getOrDefault("REASON_TIMEOUT_MS", "55000"));

    Javalin.create(cfg -> {
      cfg.http.maxRequestSize = maxBytes;
      cfg.routes.get("/health", ctx -> ctx.json(Map.of("ok", true, "reasoner", "hermit", "owlapi", "5")));
      cfg.routes.post("/reason", ctx -> {
        if (!token.isEmpty() && !token.equals(ctx.header("x-token"))) {
          ctx.status(401).json(Map.of("error", "unauthorised"));
          return;
        }
        Request req;
        try {
          req = JSON.readValue(ctx.body(), Request.class);
        } catch (Exception e) {
          ctx.status(400).json(Map.of("error", "invalid JSON body"));
          return;
        }
        respond(ctx, req, timeoutMs);
      });
    }).start(port);
  }

  private static void respond(Context ctx, Request req, long timeoutMs) {
    try {
      ctx.json(new Reasoning(req, timeoutMs).run());
    } catch (Reasoning.BadInput e) {
      ctx.status(422).json(Map.of("error", e.getMessage()));
    } catch (Exception e) {
      ctx.status(500).json(Map.of("error", e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage())));
    }
  }

  private App() {}
}

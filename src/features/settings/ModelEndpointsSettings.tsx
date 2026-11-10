import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { modelEndpointsApi, modelEndpointsKey, splitModels, type ModelEndpoint } from "../../lib/modelEndpointsApi";
import { InlineError, Modal } from "../../components/ui/ui";

/** Add, edit and remove OpenAI-compatible endpoints. `onChange` refreshes the provider list. */
export default function ModelEndpointsSettings({ onChange }: { onChange: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: modelEndpointsKey, queryFn: modelEndpointsApi.list });
  const [editing, setEditing] = useState<ModelEndpoint | "new" | null>(null),
    [removing, setRemoving] = useState<ModelEndpoint | null>(null);
  const changed = () => {
    void qc.invalidateQueries({ queryKey: modelEndpointsKey });
    onChange();
  };
  const remove = useMutation({
    mutationFn: (endpoint: ModelEndpoint) => modelEndpointsApi.remove(endpoint.id),
    onSuccess: () => {
      setRemoving(null);
      changed();
    },
  });
  if (list.data && !list.data.available) return null;
  return (
    <section className="card settings-card" aria-labelledby="st-endpoints">
      <div className="settings-section-head settings-endpoints-head">
        <div>
          <h2 id="st-endpoints">OpenAI-compatible endpoints</h2>
          <p>Add any server that speaks the OpenAI API: a university or company gateway, LiteLLM, vLLM, LM Studio or Ollama.</p>
        </div>
        <button className="btn sm" onClick={() => setEditing("new")}>
          Add endpoint
        </button>
      </div>
      <InlineError error={list.error} />
      {!!list.data?.endpoints.length && (
        <ul className="provider-list settings-provider-list">
          {list.data.endpoints.map((e) => (
            <li key={e.id}>
              <span className="settings-provider-name">
                <strong>{e.label}</strong>
                <small className="settings-endpoint-url">{e.baseUrl}</small>
                <small>
                  {e.models.length} model{e.models.length === 1 ? "" : "s"} · {e.hasKey ? "API key stored on this computer" : "No API key"}
                </small>
              </span>
              <span className="settings-endpoint-actions">
                <button className="btn ghost sm" onClick={() => setEditing(e)}>
                  Edit
                </button>
                <button className="btn ghost sm danger" onClick={() => setRemoving(e)}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint">
        Keys are encrypted on this computer and are never shown again. Prompts and documents are sent to the server you add.
      </p>
      {editing && (
        <EndpointForm
          endpoint={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            changed();
          }}
        />
      )}
      {removing && (
        <Modal
          title={`Remove ${removing.label}?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button className="btn danger" disabled={remove.isPending} onClick={() => remove.mutate(removing)}>
                Remove
              </button>
            </>
          }
        >
          <p>This removes the endpoint and its stored key. Finished runs keep their results.</p>
          <InlineError error={remove.error} />
        </Modal>
      )}
    </section>
  );
}

function EndpointForm({ endpoint: e, onClose, onSaved }: { endpoint?: ModelEndpoint; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(e?.label ?? ""),
    [baseUrl, setBaseUrl] = useState(e?.baseUrl ?? ""),
    [apiKey, setApiKey] = useState(""),
    [models, setModels] = useState(e?.models.join("\n") ?? "");
  const key = apiKey.trim() || undefined;
  const discover = useMutation({
    mutationFn: () => modelEndpointsApi.discover({ baseUrl, apiKey: key, id: e?.id }),
    onSuccess: (found) => {
      setBaseUrl(found.baseUrl);
      setModels(found.models.join("\n"));
    },
  });
  const save = useMutation({
    // An empty list means "use what the server offers": fetch it, then save.
    mutationFn: async () => {
      let list = splitModels(models);
      if (!list.length) {
        list = (await modelEndpointsApi.discover({ baseUrl, apiKey: key, id: e?.id })).models;
        setModels(list.join("\n"));
      }
      return modelEndpointsApi.save({ label, baseUrl, models: list, apiKey: key }, e?.id);
    },
    onSuccess: onSaved,
  });
  const count = splitModels(models).length;
  return (
    <Modal
      title={e ? "Edit endpoint" : "Add OpenAI-compatible endpoint"}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => save.mutate()} disabled={!label.trim() || !baseUrl.trim() || save.isPending}>
            {save.isPending ? "Saving…" : "Save endpoint"}
          </button>
        </>
      }
    >
      <div className="settings-endpoint-form">
        <label className="field">
          <span>Name</span>
          <input
            value={label}
            onChange={(ev) => setLabel(ev.target.value)}
            maxLength={80}
            placeholder="University LLM API"
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            onChange={(ev) => setBaseUrl(ev.target.value)}
            placeholder="https://llm.example.org/v1"
            autoComplete="off"
          />
          <small>
            Usually ends in <code>/v1</code>; it is added when you enter only the host. For Ollama use{" "}
            <code>http://localhost:11434/v1</code>.
          </small>
        </label>
        <label className="field">
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(ev) => setApiKey(ev.target.value)}
            placeholder={e?.hasKey ? "Leave blank to keep the current key" : "sk-…"}
            autoComplete="new-password"
          />
          <small>Optional for local servers such as Ollama or LM Studio.</small>
        </label>
        <label className="field">
          <span>Models</span>
          <textarea
            value={models}
            onChange={(ev) => setModels(ev.target.value)}
            rows={5}
            placeholder={"One model id per line"}
            spellCheck={false}
          />
          <small>Only the models listed here appear in the model picker. Leave empty to use every model the server lists.</small>
        </label>
        <div className="settings-endpoint-discover">
          <button className="btn ghost sm" onClick={() => discover.mutate()} disabled={!baseUrl.trim() || discover.isPending}>
            {discover.isPending ? "Contacting server…" : "Test and fetch models"}
          </button>
          {discover.isSuccess && (
            <span className="settings-endpoint-ok" role="status">
              Connected · {count} model{count === 1 ? "" : "s"} listed. Remove any you do not want.
            </span>
          )}
        </div>
        <InlineError error={discover.error} />
        <InlineError error={save.error} />
      </div>
    </Modal>
  );
}

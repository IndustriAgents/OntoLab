import type { ChunkSettings } from "../../types/research";
import type { GenerationModelChoice } from "../../lib/buildPreparation";
import { CHUNK_METHODS } from "../../lib/research";
import { TokenChunkControls } from "./TokenChunkControls";

export function ChunkConfigurationControls({
  pid,
  settings,
  onChange,
  onModelChoice,
}: {
  pid: string;
  settings: ChunkSettings;
  onChange: (settings: ChunkSettings) => void;
  onModelChoice?: (choice: GenerationModelChoice) => void;
}) {
  return (
    <>
      <TokenChunkControls pid={pid} settings={settings} onChange={onChange} onModelChoice={onModelChoice} />
      <div className="research-controls">
        <label className="field">
          <span>Method</span>
          <select
            value={settings.method}
            onChange={(event) => onChange({ ...settings, method: event.target.value as ChunkSettings["method"] })}
          >
            {Object.entries(CHUNK_METHODS).map(([value, method]) => (
              <option key={value} value={value}>
                {settings.unit === "tokens" && value === "fixed" ? "Fixed token windows" : method.name}
              </option>
            ))}
          </select>
        </label>
        {settings.unit !== "tokens" && (
          <label className="field">
            <span>Base size · characters</span>
            <input
              type="number"
              min={200}
              max={60000}
              step={100}
              value={settings.maxChars}
              onChange={(event) => onChange({ ...settings, maxChars: event.target.valueAsNumber })}
            />
          </label>
        )}
        <label className="field">
          <span>Requested overlap · %</span>
          <input
            type="number"
            min={0}
            max={30}
            step={1}
            value={Math.round(settings.overlap * 100)}
            onChange={(event) => onChange({ ...settings, overlap: event.target.valueAsNumber / 100 })}
          />
        </label>
      </div>
      <p>
        {settings.unit === "tokens"
          ? "Split at natural boundaries and keep every chunk, including overlap, within the generation token budget. Smaller embedding passages cover each chunk in full."
          : CHUNK_METHODS[settings.method].description}
      </p>
      {settings.unit !== "tokens" && (
        <p className="field-hint">
          Overlap is added after packing, so final chunks may exceed the base size. Boundary alignment can reduce the actual overlap.
          Smaller chunks improve focus; larger chunks preserve more context.
        </p>
      )}
    </>
  );
}

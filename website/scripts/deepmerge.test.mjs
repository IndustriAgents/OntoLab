import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
// Resolve exactly the dependency used by the installed SVG plugin, including its override.
const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve("@svgr/plugin-svgo"));
const merge = pluginRequire("deepmerge");

test("patched SVG dependency rejects prototype keys from either merge operand", () => {
  const hostile = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},"safe":1}',
  );
  for (const result of [
    merge({}, hostile),
    merge(hostile, {}),
    merge.all([{}, hostile]),
    merge({ nested: {} }, { nested: hostile }).nested,
  ]) {
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.polluted, undefined);
    for (const key of ["__proto__", "constructor", "prototype"]) assert.equal(Object.hasOwn(result, key), false);
    assert.equal(result.safe, 1);
  }
  assert.equal({}.polluted, undefined);
});
test("patched merge retains nested configuration, arrays, symbols and custom array behavior", () => {
  const symbol = Symbol("configuration");
  const input = { nested: { enabled: true }, list: [1], [symbol]: 7 };
  assert.deepEqual(merge(input, { nested: { label: "SVG" }, list: [2] }), {
    nested: { enabled: true, label: "SVG" },
    list: [1, 2],
    [symbol]: 7,
  });
  assert.deepEqual(merge([1], [2], { arrayMerge: (_target, source) => source }), [2]);
  assert.deepEqual(input.list, [1]);
});

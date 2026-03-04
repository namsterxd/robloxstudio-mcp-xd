import { TOOL_DEFINITIONS } from '../tools/definitions.js';

type JsonSchema = Record<string, unknown>;

function collectArraySchemasMissingItems(schema: unknown, path: string, out: string[]) {
  if (!schema || typeof schema !== 'object') return;

  const node = schema as JsonSchema;
  if (node.type === 'array' && !('items' in node)) {
    out.push(path);
  }

  const nestedArrays = ['anyOf', 'oneOf', 'allOf'];
  for (const key of nestedArrays) {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((entry, index) => collectArraySchemasMissingItems(entry, `${path}.${key}[${index}]`, out));
    }
  }

  const properties = node.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      collectArraySchemasMissingItems(value, `${path}.properties.${key}`, out);
    }
  }

  const items = node.items;
  if (Array.isArray(items)) {
    items.forEach((entry, index) => collectArraySchemasMissingItems(entry, `${path}.items[${index}]`, out));
  } else {
    collectArraySchemasMissingItems(items, `${path}.items`, out);
  }

  const additionalProperties = node.additionalProperties;
  if (additionalProperties && typeof additionalProperties === 'object') {
    collectArraySchemasMissingItems(additionalProperties, `${path}.additionalProperties`, out);
  }
}

describe('Tool schema compatibility', () => {
  test('every array schema declares items', () => {
    const missing: string[] = [];

    for (const tool of TOOL_DEFINITIONS) {
      collectArraySchemasMissingItems(tool.inputSchema, tool.name, missing);
    }

    expect(missing).toEqual([]);
  });

  test('create_build schema uses object parts', () => {
    const createBuild = TOOL_DEFINITIONS.find(tool => tool.name === 'create_build');
    expect(createBuild).toBeDefined();

    const parts = (createBuild as any).inputSchema.properties.parts;
    expect(parts.type).toBe('array');
    expect(parts.items.type).toBe('object');
    expect(parts.items.required).toEqual(['position', 'size', 'rotation', 'paletteKey']);
  });

  test('import_scene schema uses object placements', () => {
    const importScene = TOOL_DEFINITIONS.find(tool => tool.name === 'import_scene');
    expect(importScene).toBeDefined();

    const place = (importScene as any).inputSchema.properties.sceneData.properties.place;
    expect(place.type).toBe('array');
    expect(place.items.type).toBe('object');
    expect(place.items.required).toEqual(['modelKey', 'position']);
  });
});

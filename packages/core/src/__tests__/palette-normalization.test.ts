import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

describe('Palette normalization', () => {
  test('rejects sparse palette tuples', () => {
    const tools = new RobloxStudioTools(new BridgeService()) as any;
    const sparseTuple = Array(2) as unknown as [string, string];
    sparseTuple[0] = 'Bright red';

    expect(() => tools.normalizePalette({ a: sparseTuple })).toThrow(
      'Palette key "a" must contain only non-empty string values'
    );
  });

  test('trims and keeps valid palette tuples', () => {
    const tools = new RobloxStudioTools(new BridgeService()) as any;

    const normalized = tools.normalizePalette({
      ' a ': [' Bright red ', ' Plastic ', ' MyVariant ']
    });

    expect(normalized).toEqual({
      a: ['Bright red', 'Plastic', 'MyVariant']
    });
  });
});

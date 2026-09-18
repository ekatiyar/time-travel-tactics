import type { Mode } from '../types.js';

export const sandbox: Mode<null> = {
  id: 'sandbox',
  init: () => null,
  afterTurn: () => {},
  outcome: () => ({ status: 'running' }),
  digest: () => '',
  view: () => ({ keys: [], keyAtCenter: [], fronts: [] })
};

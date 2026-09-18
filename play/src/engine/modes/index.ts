import type { Mode, ModeId } from '../types.js';
import { sandbox } from './sandbox.js';
import { bootstrap } from './bootstrap.js';

export const MODES: Record<ModeId, Mode<any>> = { sandbox, bootstrap };

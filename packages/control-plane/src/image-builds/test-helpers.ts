import { MIN_REBUILD_RUNTIME_GENERATION } from "../sandbox/runtime-manifest";

// A runtime the scheduler treats as current: at the rebuild floor, which is
// itself at or above the boot-compatibility floor.
export const COMPATIBLE_RUNTIME_VERSION = `v${MIN_REBUILD_RUNTIME_GENERATION}-test-runtime`;

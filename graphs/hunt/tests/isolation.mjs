// Reproductions run only in a Linux PID namespace (evidence.mjs isolation()). Tests that need one
// skip with this reason wherever it is unavailable; on such a Linux host it is false and they run.
import { isolation } from '../skills/bughunt/evidence.mjs'

export const NO_ISOLATION = isolation().pidns ? false : 'reproductions need Linux namespace isolation (bughunt evidence.mjs)'

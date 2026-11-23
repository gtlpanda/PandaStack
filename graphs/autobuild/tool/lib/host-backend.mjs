// The host app (Codex CLI or Claude Code) as autobuild's default backend. Asked only by a command that is
// about to start a provider (`autobuild run`, `autobuild init`), never by loadConfig, so `autobuild status`
// or the gate in a Claude-configured project (USD budgets) still loads when it is run from inside Codex.
// A flag or AUTOBUILD_BACKEND already decided: the host is not asked (and a bad PANDASTACK_PROVIDER is not read).
import { detectHostProvider } from "../../../../core/skills/native-runtime/host-provider.mjs";

export function defaultBackendFor({ flag, env = process.env } = {}) {
  if (flag || env.AUTOBUILD_BACKEND) return undefined;
  return detectHostProvider({ env }).provider;
}

/**
 * `autobuild run` picked `backend` only because of the app the user is in. When loading that config then fails
 * (a Claude-shaped project from inside Codex, for example one with limits.totalBudgetUsd, which Codex cannot
 * meter), say how to choose the other provider; the original message stays first and intact.
 */
export function withHostBackendHint(error, hostBackend) {
  if (!hostBackend || !(error instanceof Error)) return error;
  error.message += ` (autobuild run took "${hostBackend}" as its default because that is the app you are in; autobuild.json "backend", AUTOBUILD_BACKEND or --backend choose another)`;
  return error;
}

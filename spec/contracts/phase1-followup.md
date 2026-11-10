# Phase 1 final review follow-up

P1-06 preserves every previous contract and addresses two confirmed defects.

1. resolveManagedConfig with an explicit central configuration must not evaluate
   source-installation DEFAULTS getters. Doctor must inspect a valid selected
   pandaRoot even when its source checkout has no agent-config.json. Keep the
   public DEFAULTS compatibility surface and normal launcher precedence intact.
2. Store publication cleanup must remove temporary files even when closeSync
   releases the temporary descriptor then reports EIO. Do not retry that closed
   descriptor, and do not let a cleanup error skip independent cleanup. Preserve
   safe IO_ERROR reporting, anchored directory operations, and descriptor closure.

The frozen acceptance uses node:test so assertion failures produce nonzero exit.
The prior hunt falsely classified its custom-harness close-error reproduction
because that harness was invoked with node --test without its aggregate runner.
These are normal configuration and I/O fault-injection tests; do not retry the
previously blocked filesystem-race reproduction. The external host still owns
all full gates and final branch review. No runner promotion is authorized.

import type { Principal } from "../auth/principal";

const APP_PARTICIPANT_PREFIX = "app:";

/**
 * A product's user, relayed by its backend as `app:<id>`, works alone: only the sessions they
 * started exist for them, whatever a session row or the deployment's configuration says.
 */
export function isAppUser(principal: Principal | undefined): boolean {
  return principal?.kind === "service" && principal.actor?.provider === "app";
}

/** The same rule from a session participant's id, which keeps the `app:<id>` the actor arrived as. */
export function isAppUserParticipant(participantUserId: string): boolean {
  return participantUserId.startsWith(APP_PARTICIPANT_PREFIX);
}

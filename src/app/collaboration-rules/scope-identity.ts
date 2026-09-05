import type { CollaborationRuleOwner, CollaborationRuleScope } from "./contracts.js";

export function collaborationRuleScopeIdentity(scope: CollaborationRuleScope): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`;
}

export function collaborationRuleOwnerIdentity(owner: CollaborationRuleOwner): string {
  return collaborationRuleScopeIdentity(owner);
}

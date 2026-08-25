import type { ConversationOwner } from "../../../domain/execution-scope/index.js";
import type {
  OrdinaryAgentFeature,
  OrdinaryRunBirth,
  SubmitOrdinaryTurnResult,
} from "../../ordinary-agent/index.js";
import type { SpaceFeature } from "../../spaces/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import type {
  ConversationLifecycleCoordinator,
  SpaceConversationDeletionCoordinator,
} from "../spaces/space-conversation-coordinator.js";
import type { WorkspaceDeletionCoordinator } from "../spaces/workspace-deletion-coordinator.js";
import { resolveConversationSpaceAccess } from "../spaces/space-agent-access.js";
import type { PanelRunInput } from "../request-parsers.js";

export type OrdinaryTurnApplicationErrorCode =
  | "conversation_owner_required"
  | "new_conversation_owner_required"
  | "conversation_owner_conflict"
  | "conversation_space_not_found";

/** Structured application failure. The Panel adapter maps this to HTTP. */
export class OrdinaryTurnApplicationError extends Error {
  readonly name = "OrdinaryTurnApplicationError";

  constructor(
    readonly code: OrdinaryTurnApplicationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The application-level boundary for submitting one Ordinary turn.
 *
 * HTTP routes should only parse the request and project the result. Owner
 * resolution, Space access freezing, run-birth preparation, and deletion
 * admission are one use case so that future policy changes have one entry
 * point instead of growing another orchestration branch in a route.
 */
export type OrdinaryTurnApplication = {
  submit(input: {
      readonly runInput: PanelRunInput;
      readonly conversationId?: string;
    }): Promise<OrdinaryTurnApplicationResult>;
};

export type OrdinaryTurnApplicationResult = {
  readonly submitted: SubmitOrdinaryTurnResult;
  readonly owner: ConversationOwner;
  readonly spaceId?: string;
};

export type OrdinaryTurnApplicationDependencies = {
  readonly ordinaryAgentFeature: {
    readonly commands: Pick<OrdinaryAgentFeature["commands"], "submitTurn">;
    readonly queries: Pick<OrdinaryAgentFeature["queries"], "getConversationOwner">;
  };
  readonly spaceFeature: {
    readonly queries: Pick<SpaceFeature["queries"], "getTree">;
  };
  readonly workspaceFeature: {
    readonly commands: Pick<WorkspaceFeature["commands"], "invalidateMount">;
    readonly queries: Pick<WorkspaceFeature["queries"], "get">;
  };
  readonly conversationLifecycle: Pick<ConversationLifecycleCoordinator, "assertConversationAvailable" | "submit">;
  readonly spaceConversationDeletion: Pick<SpaceConversationDeletionCoordinator, "assertAvailable" | "admit">;
  readonly workspaceDeletion: Pick<WorkspaceDeletionCoordinator, "assertAvailable" | "admit">;
  readonly prepareOrdinaryRunBirth: (input: PanelRunInput, conversationId?: string) => Promise<OrdinaryRunBirth>;
};

export function createOrdinaryTurnApplication(
  runtime: OrdinaryTurnApplicationDependencies,
): OrdinaryTurnApplication {
  return {
    submit: async ({ runInput, conversationId }) => {
      if (conversationId !== undefined) {
        runtime.conversationLifecycle.assertConversationAvailable(conversationId);
      }

      const explicitOwner = runInput.owner;
      const canonicalOwner = conversationId === undefined
        ? undefined
        : await runtime.ordinaryAgentFeature.queries.getConversationOwner(conversationId);
      if (conversationId !== undefined && canonicalOwner === undefined) {
        throw new OrdinaryTurnApplicationError("conversation_owner_required", "Conversation 缺少稳定 owner，不能继续提交。");
      }
      if (canonicalOwner !== undefined) {
        if (canonicalOwner.kind === "space") {
          runtime.spaceConversationDeletion.assertAvailable(canonicalOwner.id);
        } else {
          runtime.workspaceDeletion.assertAvailable(canonicalOwner.id);
        }
      }
      if (explicitOwner !== undefined && canonicalOwner !== undefined && !sameConversationOwner(explicitOwner, canonicalOwner)) {
        throw new OrdinaryTurnApplicationError(
          "conversation_owner_conflict",
          `Conversation ${conversationId} already belongs to ${canonicalOwner.kind} ${canonicalOwner.id}.`,
        );
      }

      // Existing conversations always use their canonical owner. A turn may
      // omit that owner, but it can never select a different scope.
      const owner = canonicalOwner ?? explicitOwner;
      if (owner === undefined) {
        throw new OrdinaryTurnApplicationError("new_conversation_owner_required", "开始新对话前请选择空间或工作区。");
      }

      const selectedSpaceId = owner.kind === "space" ? owner.id : undefined;
      if (owner.kind === "workspace") {
        // Fast in-process rejection; admission below also checks durable
        // deletion state around the actual submit.
        runtime.workspaceDeletion.assertAvailable(owner.id);
      }

      const submissionId = conversationId === undefined
        ? runInput.submissionId ?? crypto.randomUUID()
        : runInput.submissionId;
      const spaceAccess = await resolveConversationSpaceAccess(
        runtime.spaceFeature,
        runtime.workspaceFeature,
        (id) => runtime.ordinaryAgentFeature.queries.getConversationOwner(id),
        conversationId,
        runInput.contextInput,
        selectedSpaceId,
      );
      if (spaceAccess.spaceId !== undefined) {
        runtime.spaceConversationDeletion.assertAvailable(spaceAccess.spaceId);
      }
      if (conversationId === undefined && selectedSpaceId !== undefined && spaceAccess.spaceId !== selectedSpaceId) {
        throw new OrdinaryTurnApplicationError("conversation_space_not_found", "所选空间不存在。");
      }

      const effectiveRunInput: PanelRunInput = {
        ...runInput,
        owner,
        contextInput: spaceAccess.contextInput,
      };
      const birth = await runtime.prepareOrdinaryRunBirth(effectiveRunInput, conversationId);
      const submitted = conversationId === undefined
        ? await runtime.conversationLifecycle.submit({
            owner,
            submissionId: submissionId!,
            runInput: { userMessage: effectiveRunInput.goal, context: effectiveRunInput.contextInput },
            birth,
          })
        : owner.kind === "workspace"
          ? await runtime.workspaceDeletion.admit(owner.id, () => submitExistingConversationTurn(
              runtime,
              conversationId,
              owner,
              effectiveRunInput,
              birth,
            ))
          : await runtime.spaceConversationDeletion.admit(owner.id, () => submitExistingConversationTurn(
              runtime,
              conversationId,
              owner,
              effectiveRunInput,
              birth,
            ));

      return {
        submitted,
        owner,
        spaceId: spaceAccess.spaceId,
      };
    },
  };
}

async function submitExistingConversationTurn(
  runtime: OrdinaryTurnApplicationDependencies,
  conversationId: string,
  owner: ConversationOwner,
  input: PanelRunInput,
  birth: OrdinaryRunBirth,
): Promise<SubmitOrdinaryTurnResult> {
  return runtime.ordinaryAgentFeature.commands.submitTurn({
    conversationId,
    owner,
    submissionId: input.submissionId,
    input: { userMessage: input.goal, context: input.contextInput },
    birth,
  });
}

function sameConversationOwner(left: ConversationOwner, right: ConversationOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

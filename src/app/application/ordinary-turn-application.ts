import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import type { OrdinaryRunContextInput } from "../../domain/ordinary/index.js";
import type { ModelRunReasoningEffort } from "../../domain/config/index.js";
import type { ToolConfirmationPolicy } from "../../domain/tools/index.js";
import type { ModelRuntimeMode } from "../model-runtime/index.js";
import type {
  OrdinaryAgentFeature,
  OrdinaryRunBirth,
  OrdinaryRunInput,
  SubmitOrdinaryTurnResult,
} from "../ordinary-agent/index.js";

export type OrdinaryTurnInput = {
  readonly goal: string;
  readonly submissionId?: string;
  readonly owner?: ConversationOwner;
  readonly aiMode?: ModelRuntimeMode;
  readonly reasoningEffort?: ModelRunReasoningEffort;
  readonly toolConfirmationPolicy?: ToolConfirmationPolicy;
  readonly modelOverride?: {
    readonly profileId: string;
    readonly model: string;
  };
  readonly contextInput?: OrdinaryRunContextInput;
};

export type OrdinaryTurnApplicationErrorCode =
  | "conversation_owner_required"
  | "new_conversation_owner_required"
  | "conversation_owner_conflict"
  | "conversation_space_not_found";

/** Structured application failure. An adapter maps this to its own protocol. */
export class OrdinaryTurnApplicationError extends Error {
  readonly name = "OrdinaryTurnApplicationError";

  constructor(
    readonly code: OrdinaryTurnApplicationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type OrdinaryTurnApplication = {
  submit(input: {
    readonly runInput: OrdinaryTurnInput;
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
  readonly conversationLifecycle: {
    assertConversationAvailable(conversationId: string): void;
    submit(input: {
      readonly owner: ConversationOwner;
      readonly submissionId: string;
      readonly runInput: OrdinaryRunInput;
      readonly birth: OrdinaryRunBirth;
    }): Promise<SubmitOrdinaryTurnResult>;
  };
  readonly spaceConversationDeletion: {
    assertAvailable(spaceId: string): void;
    admit<T>(spaceId: string, operation: () => Promise<T>): Promise<T>;
  };
  readonly workspaceDeletion: {
    assertAvailable(workspaceId: string): void;
    admit<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
  };
  readonly resolveSpaceAccess: (input: {
    readonly conversationId?: string;
    readonly contextInput?: OrdinaryRunContextInput;
    readonly requestedSpaceId?: string;
  }) => Promise<{ readonly spaceId?: string; readonly contextInput?: OrdinaryRunContextInput }>;
  readonly prepareOrdinaryRunBirth: (input: OrdinaryTurnInput, conversationId?: string) => Promise<OrdinaryRunBirth>;
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

      const owner = canonicalOwner ?? explicitOwner;
      if (owner === undefined) {
        throw new OrdinaryTurnApplicationError("new_conversation_owner_required", "开始新对话前请选择空间或工作区。");
      }

      const selectedSpaceId = owner.kind === "space" ? owner.id : undefined;
      if (owner.kind === "workspace") runtime.workspaceDeletion.assertAvailable(owner.id);

      const submissionId = conversationId === undefined
        ? runInput.submissionId ?? crypto.randomUUID()
        : runInput.submissionId;
      const spaceAccess = await runtime.resolveSpaceAccess({
        conversationId,
        contextInput: runInput.contextInput,
        requestedSpaceId: selectedSpaceId,
      });
      if (spaceAccess.spaceId !== undefined) {
        runtime.spaceConversationDeletion.assertAvailable(spaceAccess.spaceId);
      }
      if (conversationId === undefined && selectedSpaceId !== undefined && spaceAccess.spaceId !== selectedSpaceId) {
        throw new OrdinaryTurnApplicationError("conversation_space_not_found", "所选空间不存在。");
      }

      const effectiveRunInput: OrdinaryTurnInput = {
        ...runInput,
        owner,
        contextInput: spaceAccess.contextInput,
      };
      const birth = await runtime.prepareOrdinaryRunBirth(effectiveRunInput, conversationId);
      const submitted = conversationId === undefined
        ? await runtime.conversationLifecycle.submit({
            owner,
            submissionId: submissionId!,
            runInput: {
              userMessage: effectiveRunInput.goal,
              context: effectiveRunInput.contextInput,
            },
            birth,
          })
        : owner.kind === "workspace"
          ? await runtime.workspaceDeletion.admit(owner.id, () => submitExistingConversationTurn(runtime, conversationId, owner, effectiveRunInput, birth))
          : await runtime.spaceConversationDeletion.admit(owner.id, () => submitExistingConversationTurn(runtime, conversationId, owner, effectiveRunInput, birth));

      return { submitted, owner, spaceId: spaceAccess.spaceId };
    },
  };
}

async function submitExistingConversationTurn(
  runtime: OrdinaryTurnApplicationDependencies,
  conversationId: string,
  owner: ConversationOwner,
  input: OrdinaryTurnInput,
  birth: OrdinaryRunBirth,
): Promise<SubmitOrdinaryTurnResult> {
  return runtime.ordinaryAgentFeature.commands.submitTurn({
    conversationId,
    owner,
    submissionId: input.submissionId,
    input: {
      userMessage: input.goal,
      context: input.contextInput,
    },
    birth,
  });
}

function sameConversationOwner(left: ConversationOwner, right: ConversationOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

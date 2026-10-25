import { sessionBudgetUpdateSchema } from "@open-inspect/shared/types/session-api";
import type { SessionBudgetService } from "../../budget-service";
import { DEFAULT_SESSION_PERMISSION_MODE } from "@open-inspect/shared/types/sessions";
import type { MessageRepository } from "../../message-repository";
import type { SessionCoreRepository } from "../../session-core-repository";

export class SessionBudgetHandler {
  constructor(
    private readonly repository: SessionCoreRepository,
    private readonly budgetService: SessionBudgetService,
    private readonly now: () => number,
    private readonly messageRepository: Pick<MessageRepository, "getRunningTurnCost">
  ) {}

  async update(request: Request): Promise<Response> {
    const session = this.repository.getSession();
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

    const parsed = sessionBudgetUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid budget request" }, { status: 400 });
    }

    await this.budgetService.updateLimit(parsed.data.maxCostUsd, this.now());
    const updated = this.repository.getSession();
    if (!updated) return Response.json({ error: "Session not found" }, { status: 404 });
    return Response.json({
      totalCost: this.budgetService.spentUsd(),
      maxSessionCostUsd: updated.max_cost_usd,
      budgetExhausted: updated.budget_exhausted === 1,
    });
  }

  /**
   * What the sandbox's spend check needs: the permission mode and what the session has spent so
   * far. `totalCost` is USD, counted once the runtime reports a turn's cost (for the Claude
   * agent, when the turn ends), so `runningTurn` says when the running turn started and how much
   * of it `totalCost` already holds; the caller adds the rest from the gateway's ledger.
   */
  read(): Response {
    const session = this.repository.getSession();
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
    return Response.json({
      permissionMode: session.permission_mode ?? DEFAULT_SESSION_PERMISSION_MODE,
      // The model's cost and the media's: what counts against the budget.
      totalCost: this.budgetService.spentUsd(),
      maxSessionCostUsd: session.max_cost_usd,
      budgetExhausted: session.budget_exhausted === 1,
      runningTurn: this.messageRepository.getRunningTurnCost(),
    });
  }
}

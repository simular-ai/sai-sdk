package ai.simular.sai;

/** With {@code judgeInitialAgentRun}: the judgement of a learn job's agent run. */
public record AgentJudgement(String judgementId, String verdict, String summary) {}

package ai.simular.sai;

/**
 * Answers an approval while a turn is waited on: an {@link ApprovalAnswer}, or null to leave it
 * pending (e.g. a person answers it in a browser).
 */
@FunctionalInterface
public interface ApprovalHandler {
  ApprovalAnswer answer(Approval approval);
}

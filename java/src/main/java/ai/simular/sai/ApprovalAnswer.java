package ai.simular.sai;

import java.util.List;

/**
 * An answer to an approval: {@code yes}, {@code no} or {@code task} (allow for the rest of the
 * task), and for a {@code choice} approval, one list of option values per question.
 */
public record ApprovalAnswer(String response, List<List<String>> selections) {
  public static ApprovalAnswer of(String response) {
    return new ApprovalAnswer(response, null);
  }

  public static ApprovalAnswer of(String response, List<List<String>> selections) {
    return new ApprovalAnswer(response, selections);
  }
}

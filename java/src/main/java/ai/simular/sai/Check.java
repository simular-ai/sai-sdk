package ai.simular.sai;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One yes/no constraint a turn is checked against after it ends.
 *
 * @param id letters, digits, {@code _} or {@code -}; at most 64 characters
 * @param returnEvidence also return one sentence of evidence for this check (an extra model call);
 *     null leaves it out
 */
public record Check(String id, String check, Boolean returnEvidence) {
  public Check(String id, String check) {
    this(id, check, null);
  }

  Map<String, Object> toJson() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("id", id);
    m.put("check", check);
    if (returnEvidence != null) m.put("returnEvidence", returnEvidence);
    return m;
  }

  /** A string as is; a list of checks as JSON. */
  static Object criteria(Object criteria) {
    if (criteria instanceof java.util.List<?> l) {
      java.util.List<Object> out = new java.util.ArrayList<>();
      for (Object c : l) out.add(c instanceof Check k ? k.toJson() : c);
      return out;
    }
    return criteria;
  }
}

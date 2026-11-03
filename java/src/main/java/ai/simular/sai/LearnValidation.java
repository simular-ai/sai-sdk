package ai.simular.sai;

import java.util.List;

/** Problems found in learned code. A result with {@code errors} comes back failed. */
public record LearnValidation(List<String> errors, List<String> warnings) {}

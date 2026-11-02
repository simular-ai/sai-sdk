package ai.simular.sai;

/** One input of learned code: a {@code {{name}}} in the template and a key of {@code main}'s params. */
public record LearnParameter(String name, String defaultValue, String description) {}

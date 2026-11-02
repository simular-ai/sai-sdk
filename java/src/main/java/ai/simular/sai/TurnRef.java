package ai.simular.sai;

/** Something that names a turn: a {@link Turn} or a {@link TurnRecord}. */
public interface TurnRef {
  /** The turn's id; null when the message was answered without starting one. */
  String id();

  static String idOf(Object turn) {
    String id =
        turn instanceof String s
            ? s
            : turn instanceof TurnRef t
                ? t.id()
                : null;
    if (turn != null && !(turn instanceof String) && !(turn instanceof TurnRef)) {
      throw new IllegalArgumentException(
          "A turn is an id string, a Turn or a TurnRecord, not " + turn.getClass().getName());
    }
    if (id == null || id.isEmpty()) {
      throw new IllegalArgumentException(
          "This turn has no id: the message was answered without starting one.");
    }
    return id;
  }
}

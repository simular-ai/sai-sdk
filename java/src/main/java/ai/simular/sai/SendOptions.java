package ai.simular.sai;

import java.util.List;
import java.util.Map;

/**
 * Options for {@code session.send()} and {@code session.run()}. Any of {@code inputs}, {@code
 * outputSchema} or {@code successCriteria} makes the message structured.
 */
public final class SendOptions {
  String model;
  List<Attachment> attachments;
  Map<String, ?> inputs;
  Map<String, ?> outputSchema;
  Object successCriteria;
  String idempotencyKey;
  boolean recordTrajectory;
  String thinkingLevel;
  boolean autonomous;

  /** An id from {@code sai.models().list()} (or {@code auto}); sticks to the session until changed. */
  public SendOptions model(String model) {
    this.model = model;
    return this;
  }

  public SendOptions attachments(List<Attachment> attachments) {
    this.attachments = attachments;
    return this;
  }

  /** Values for the {@code {{name}}} placeholders in the message. Makes the message structured. */
  public SendOptions inputs(Map<String, ?> inputs) {
    this.inputs = inputs;
    return this;
  }

  /** JSON Schema (at most 32 KB) the turn's output must match. Makes the message structured. */
  public SendOptions outputSchema(Map<String, ?> outputSchema) {
    this.outputSchema = outputSchema;
    return this;
  }

  /** A guideline for a judge the turn is checked against. Makes the message structured. */
  public SendOptions successCriteria(String guideline) {
    this.successCriteria = guideline;
    return this;
  }

  /** Yes/no checks the turn is checked against. Makes the message structured. */
  public SendOptions successCriteria(List<Check> checks) {
    this.successCriteria = checks;
    return this;
  }

  /** The same key again returns the earlier turn and sends nothing. */
  public SendOptions idempotencyKey(String idempotencyKey) {
    this.idempotencyKey = idempotencyKey;
    return this;
  }

  /** Keep a screenshot and the action for each step ({@code sai.turns().trajectory()}). */
  public SendOptions recordTrajectory(boolean recordTrajectory) {
    this.recordTrajectory = recordTrajectory;
    return this;
  }

  /**
   * {@code off}, {@code low}, {@code medium}, {@code high} or {@code xhigh} for the turn this
   * message starts, in place of the account's agent setting. Refused with {@link
   * ConflictException} ({@code session_busy}) while a turn is running.
   */
  public SendOptions thinkingLevel(String thinkingLevel) {
    this.thinkingLevel = thinkingLevel;
    return this;
  }

  /**
   * Run the turn this message starts without approval cards, as if "Trust for this task" had been
   * answered; the grant ends with the turn.
   */
  public SendOptions autonomous(boolean autonomous) {
    this.autonomous = autonomous;
    return this;
  }

  boolean structured() {
    return inputs != null || outputSchema != null || successCriteria != null;
  }
}

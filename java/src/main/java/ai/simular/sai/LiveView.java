package ai.simular.sai;

/**
 * A computer's live screen. Both URLs carry a token: keep them private.
 *
 * @param liveUrl a page that shows the screen with no Simular sign-in: send it to the person who
 *     should act (a sign-in, a captcha). It works until {@code expiresAt} or {@code
 *     machines().revokeLive()}. Null where the server does not offer the page.
 * @param expiresAt when {@code liveUrl} stops working, Unix time in milliseconds; null without it
 * @param websocketUrl a Guacamole tunnel for a viewer of your own; it takes input too
 */
public record LiveView(
    String machineId, String liveUrl, Long expiresAt, String websocketUrl, int width, int height) {}

using System.Text.Json;
using System.Text.Json.Nodes;

namespace Simular.Sai;

/// <summary>
/// A non-2xx response from the Sai API. <see cref="Code"/> is the machine-readable <c>error</c>
/// string when the server sent one (<c>machine_busy</c>, <c>link_only</c>, ...);
/// <see cref="Exception.Message"/> is the human text; <see cref="Body"/> is the JSON body, unchanged.
/// </summary>
public class SaiException : Exception
{
    public SaiException(
        string message,
        int status = 0,
        string? code = null,
        JsonElement? body = null,
        double? retryAfter = null,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Status = status;
        Code = code;
        Body = body ?? J.EmptyObject;
        RetryAfter = retryAfter;
    }

    /// <summary>The HTTP status, or 0 when there was no response.</summary>
    public int Status { get; }

    public string? Code { get; }

    public JsonElement Body { get; }

    /// <summary>Seconds to wait before retrying: the <c>Retry-After</c> header, else <c>retryAfterSeconds</c>.</summary>
    public double? RetryAfter { get; }

    internal static SaiException For(int status, JsonElement body, double? retryAfter)
    {
        var err = body.Get("error");
        // Two body shapes: `{ error: "<human text>" }` (/v1/agents) and
        // `{ error: "<code>", message: "<human text>" }` (/v1/machines/{id}/control, newer errors).
        var code = err.ValueKind == JsonValueKind.String && (body.Has("message") || LooksLikeCode(err.GetString()!))
            ? err.GetString()
            : null;
        var message = body.Str("message") ?? err.Str() ?? $"HTTP {status}";
        if (status == 401) message += " (SAI_API_KEY was rejected: it may be revoked.)";
        // The `Retry-After` header wins; `retryAfterSeconds` is the same value in the body (`rate_limited`).
        var wait = retryAfter ?? body.Num("retryAfterSeconds");
        return code switch
        {
            "link_only" => new LinkOnlyApprovalException(message, status, code, body, wait),
            "spend_cap_reached" => new SpendCapReachedException(message, status, code, body, wait),
            _ => status switch
            {
                400 => new BadRequestException(message, status, code, body, wait),
                401 => new AuthenticationException(message, status, code, body, wait),
                403 => new PermissionDeniedException(message, status, code, body, wait),
                404 => new NotFoundException(message, status, code, body, wait),
                409 => new ConflictException(message, status, code, body, wait),
                410 => new GoneException(message, status, code, body, wait),
                429 => new RateLimitException(message, status, code, body, wait),
                503 => new ServiceUnavailableException(message, status, code, body, wait),
                _ => new SaiException(message, status, code, body, wait),
            },
        };
    }

    private static bool LooksLikeCode(string s) => s.Length > 0 && !s.Contains(' ') && s == s.ToLowerInvariant();
}

/// <summary>The API could not be reached (DNS, TLS, timeout).</summary>
public class ConnectionException(string message, Exception? innerException = null)
    : SaiException(message, innerException: innerException);

/// <summary>400: the request was invalid, e.g. several computers and no <c>machine</c>.</summary>
public class BadRequestException(string message, int status = 400, string? code = null, JsonElement? body = null, double? retryAfter = null)
    : SaiException(message, status, code, body, retryAfter);

/// <summary>401: no key, or the key is unknown or revoked.</summary>
public class AuthenticationException(string message, int status = 401, string? code = null, JsonElement? body = null, double? retryAfter = null)
    : SaiException(message, status, code, body, retryAfter);

/// <summary>403: the key is valid but the account may not do this (plan, ownership).</summary>
public class PermissionDeniedException(string message, int status = 403, string? code = null, JsonElement? body = null, double? retryAfter = null)
    : SaiException(message, status, code, body, retryAfter);

/// <summary>404.</summary>
public class NotFoundException(string message, int status = 404, string? code = null, JsonElement? body = null, double? retryAfter = null)
    : SaiException(message, status, code, body, retryAfter);

/// <summary>409: e.g. <c>machine_busy</c>, <c>link_only</c>, approval no longer pending.</summary>
public class ConflictException(string message, int status = 409, string? code = null, JsonElement? body = null, double? retryAfter = null)
    : SaiException(message, status, code, body, retryAfter);

/// <summary>
/// 410 <c>control_closed</c>: the control lease has ended (closed, sat idle, lost the computer to a
/// Sai task, or the computer stopped answering). <c>Body.reason</c> says which. Open a new one.
/// </summary>
public class GoneException(string message, int status = 410, string? code = null, JsonElement? body = null, double? retryAfter = null)
    : SaiException(message, status, code, body, retryAfter);

/// <summary>429: a rate limit, or a free-plan budget that resets daily.</summary>
public class RateLimitException(string message, int status = 429, string? code = null, JsonElement? body = null, double? retryAfter = null)
    : SaiException(message, status, code, body, retryAfter);

/// <summary>503: the computer did not come online, or no capacity. Honor <see cref="SaiException.RetryAfter"/>.</summary>
public class ServiceUnavailableException(string message, int status = 503, string? code = null, JsonElement? body = null, double? retryAfter = null)
    : SaiException(message, status, code, body, retryAfter);

/// <summary>
/// A control helper's Simulang block failed on the computer. <see cref="Kind"/> is
/// <c>exception</c>, <c>timeout</c> or <c>interrupted</c>.
/// </summary>
public class BlockException(string kind, string message) : SaiException($"{kind}: {message}", code: kind)
{
    public string Kind { get; } = kind;
}

/// <summary>The approval must be answered by a human in a browser: open <see cref="ApprovalUrl"/>.</summary>
public class LinkOnlyApprovalException(string message, int status = 409, string? code = "link_only", JsonElement? body = null, double? retryAfter = null)
    : ConflictException(message, status, code, body, retryAfter)
{
    public string? ApprovalUrl => Body.Str("approvalUrl");

    internal static LinkOnlyApprovalException For(Approval approval) => new(
        "This approval must be completed in a browser. Open approval.Url.",
        body: J.ToElement(new JsonObject { ["approvalUrl"] = approval.Url }));
}

/// <summary>
/// 403 <c>spend_cap_reached</c>: the key reached its monthly spend limit, or (on a cloud machine
/// create, <c>Body.scope == "tenant"</c>) the Tenant reached its budget. Not retryable: the limit
/// resets at <see cref="ResetsAt"/> (ISO 8601), or raise it for the key in the portal.
/// </summary>
public class SpendCapReachedException(string message, int status = 403, string? code = "spend_cap_reached", JsonElement? body = null, double? retryAfter = null)
    : PermissionDeniedException(message, status, code, body, retryAfter)
{
    public string? ResetsAt => Body.Str("resetsAt");
}

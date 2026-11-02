# frozen_string_literal: true

module Sai
  # A non-2xx response from the Sai API (the surface's +SaiError+). +code+ is the machine-readable
  # +error+ string when the server sent one (+machine_busy+, +link_only+, ...); +message+ is the
  # human text; +body+ is the parsed JSON body, unchanged.
  class Error < StandardError
    attr_reader :status, :code, :body, :retry_after

    def initialize(message = nil, status: 0, code: nil, body: {}, retry_after: nil)
      super(message)
      @status = status
      @code = code
      @body = body || {}
      @retry_after = retry_after
    end
  end

  # The API could not be reached (DNS, TLS, timeout).
  class ConnectionError < Error; end
  # 400: the request was invalid, e.g. several computers and no +machine+.
  class BadRequestError < Error; end
  # 401: no key, or the key is unknown or revoked.
  class AuthenticationError < Error; end
  # 403: the key is valid but the account may not do this (plan, ownership).
  class PermissionDeniedError < Error; end
  # 404.
  class NotFoundError < Error; end
  # 409: e.g. +machine_busy+, +link_only+, approval no longer pending.
  class ConflictError < Error; end
  # 410 +control_closed+: the control lease has ended; +body["reason"]+ says why. Open a new one.
  class GoneError < Error; end
  # 429: a rate limit, or a free-plan budget that resets daily.
  class RateLimitError < Error; end
  # 503: the computer did not come online, or no capacity. Honor +retry_after+.
  class ServiceUnavailableError < Error; end

  # A control helper's Simulang block failed on the computer. +kind+ is +exception+, +timeout+ or
  # +interrupted+.
  class BlockError < Error
    attr_reader :kind

    def initialize(kind, message)
      super("#{kind}: #{message}", code: kind)
      @kind = kind
    end
  end

  # The approval must be answered by a human in a browser: open +approval_url+.
  class LinkOnlyApprovalError < ConflictError
    def approval_url
      url = body["approvalUrl"]
      url.is_a?(String) ? url : nil
    end
  end

  # 403 +spend_cap_reached+: the key reached its monthly spend limit, or (on a cloud machine
  # create, +body["scope"] == "tenant"+) the Tenant reached its budget. Not retryable: the limit
  # resets at +resets_at+ (ISO 8601), or raise it for the key in the portal.
  class SpendCapReachedError < PermissionDeniedError
    def resets_at
      at = body["resetsAt"]
      at.is_a?(String) ? at : nil
    end
  end

  # @api private
  module Errors
    BY_CODE = {
      "link_only" => LinkOnlyApprovalError,
      "spend_cap_reached" => SpendCapReachedError
    }.freeze

    BY_STATUS = {
      400 => BadRequestError,
      401 => AuthenticationError,
      403 => PermissionDeniedError,
      404 => NotFoundError,
      409 => ConflictError,
      410 => GoneError,
      429 => RateLimitError,
      503 => ServiceUnavailableError
    }.freeze

    module_function

    def for(status, body, retry_after)
      err = body["error"]
      detail = body["message"]
      # Two body shapes: { error: "<human text>" } (/v1/agents) and
      # { error: "<code>", message: "<human text>" } (/v1/machines/{id}/control, newer errors).
      code = err.is_a?(String) && (body.key?("message") || looks_like_code?(err)) ? err : nil
      message = if detail.is_a?(String) then detail
                elsif err.is_a?(String) then err
                else "HTTP #{status}"
                end
      message += " (SAI_API_KEY was rejected: it may be revoked.)" if status == 401
      cls = BY_CODE[code] || BY_STATUS[status] || Error
      # The Retry-After header wins; retryAfterSeconds is the same value in the body (rate_limited).
      wait = retry_after
      wait = body["retryAfterSeconds"] if wait.nil? && body["retryAfterSeconds"].is_a?(Numeric)
      cls.new(message, status: status, code: code, body: body, retry_after: wait)
    end

    def looks_like_code?(s)
      !s.empty? && !s.include?(" ") && s == s.downcase
    end
  end
end

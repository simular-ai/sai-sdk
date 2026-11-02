# frozen_string_literal: true

module Sai
  # @api private
  module Util
    module_function

    # Percent-encodes like JavaScript's encodeURIComponent (a space is %20).
    def q(s)
      s.to_s.encode(Encoding::UTF_8).b.gsub(%r{[^A-Za-z0-9\-_.!~*'()]}n) { |c| format("%%%02X", c.ord) }
    end

    # An id string, or an object with an +id+ (a Machine, a Turn, a Tenant, ...).
    def id_of(ref)
      ref.is_a?(String) ? ref : ref.id
    end

    def turn_id(turn)
      id = id_of(turn)
      raise ArgumentError, "This turn has no id: the message was answered without starting one." if id.nil? || id.empty?

      id
    end

    def now_ms
      Process.clock_gettime(Process::CLOCK_REALTIME, :millisecond)
    end

    def monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end
end

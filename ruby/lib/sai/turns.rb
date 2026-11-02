# frozen_string_literal: true

require "timeout"

module Sai
  # Turns: what a message to Sai started or joined. Every message gets a turn id (+turn.id+); this
  # reads the turn's record: status, output, evidence, usage, and its trajectory when the message
  # set +record_trajectory+. Each method takes a Turn, a TurnRecord or the id string.
  class Turns
    # Between turn reads; +GET /v1/agents/turns/{id}+ never holds.
    RECORD_POLL_INTERVAL = 2

    # @api private
    def initialize(http)
      @http = http
    end

    # The turn's record now. Never waits: +finalizing+ while the result is worked out.
    # @return [TurnRecord]
    def get(turn)
      TurnRecord.parse(Parse.obj(@http.json("GET", "/v1/agents/turns/#{Util.q(Util.turn_id(turn))}")))
    end

    # Read the turn until it is +succeeded+, +failed+ or +needs_input+. On +needs_input+, answer
    # the approval on the turn's session (+sai.sessions.resume(record.session_id)+) and wait
    # again. +timeout+ (seconds) raises Timeout::Error with the turn unfinished.
    # @return [TurnRecord]
    def wait(turn, timeout: nil)
      deadline = timeout.nil? ? nil : Util.monotonic + timeout
      self.class.wait_record(@http, Util.turn_id(turn), deadline, %w[succeeded failed needs_input])
    end

    # The steps the agent took, in order. Recorded only when the message set +record_trajectory+.
    # @return [Array<TrajectoryStep>]
    def trajectory(turn)
      d = Parse.obj(@http.json("GET", "/v1/agents/turns/#{Util.q(Util.turn_id(turn))}/trajectory"))
      Parse.list(d["steps"]).map { |s| TrajectoryStep.parse(Parse.obj(s)) }
    end

    # The screen before step +index+ (the last one is after the turn), as JPEG bytes.
    # @return [String] a binary String
    def screenshot(turn, index)
      @http.request("GET", "/v1/agents/turns/#{Util.q(Util.turn_id(turn))}/trajectory/screenshots/#{index}").body
    end

    # @api private
    # Read the turn's record until its status is in +stop+. Raises Timeout::Error past +deadline+
    # (a monotonic time).
    def self.wait_record(http, turn_id, deadline, stop = %w[succeeded failed])
      loop do
        begin
          record = TurnRecord.parse(Parse.obj(http.json("GET", "/v1/agents/turns/#{Util.q(turn_id)}")))
        rescue RateLimitError => e
          sleep(e.retry_after.nil? ? 30 : e.retry_after)
          next
        end
        return record if stop.include?(record.status)
        if deadline && Util.monotonic + RECORD_POLL_INTERVAL > deadline
          raise Timeout::Error, "Turn #{turn_id} still #{record.status}."
        end

        sleep(RECORD_POLL_INTERVAL)
      end
    end

    # @api private
    def self.local_result(session_id, text)
      TurnResult.new(status: "idle", text: text, session_id: session_id, approval: nil, error: nil,
                     error_code: nil, usage: nil, session_usage: nil, record: nil)
    end
  end
end

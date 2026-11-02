# frozen_string_literal: true

require "timeout"

module Sai
  # Sessions: a conversation with Sai on one computer. Sai decides every click.
  class Sessions
    # @api private
    def initialize(http, machines)
      @http = http
      @machines = machines
    end

    # Start a fresh conversation on a computer: the next message has no memory of earlier ones.
    # +machine+ (a Machine or its id) may be left out with one computer.
    # @return [Session]
    def create(machine: nil)
      machine_id = resolve_machine(machine)
      session_id = nil
      begin
        d = @http.json("POST", "/v1/agents/new-session", json: { "machineId" => machine_id, "channel" => "api" })
        session_id = Parse.str(Parse.obj(d)["sessionId"])
      rescue NotFoundError
        # A free account's computer between claims has no conversation to rotate; the first
        # message starts one.
      end
      Session.new(@http, machine_id, session_id)
    end

    # The API sessions on a computer, most recent first (up to 20).
    # @return [Array<SessionSummary>]
    def list(machine: nil)
      machine_id = resolve_machine(machine)
      d = @http.json("GET", "/v1/agents/sessions", params: { "machineId" => machine_id, "channel" => "api" })
      Parse.list(Parse.obj(d)["sessions"]).map { |s| SessionSummary.parse(s) }
    end

    # Reattach to a session started elsewhere, e.g. to poll or abort it. Makes no request.
    # @return [Session]
    def resume(session_id, machine: nil)
      Session.new(@http, machine ? Util.id_of(machine) : nil, session_id)
    end

    private

    def resolve_machine(machine)
      return Util.id_of(machine) if machine

      machines = @machines.list
      return machines[0].id if machines.length == 1

      if machines.empty?
        raise BadRequestError.new("No computer on this account. Create one in the Sai app or the portal.",
                                  status: 400)
      end
      names = machines.map { |m| m.name ? "#{m.id} (#{m.name})" : m.id }.join(", ")
      raise BadRequestError.new("Several computers on this account; pass machine. Candidates: #{names}",
                                status: 400)
    end
  end

  # A conversation with Sai. Each +send+ is a turn; turns share context.
  class Session
    attr_accessor :id, :machine_id

    # @api private
    def initialize(http, machine_id, id)
      @http = http
      @machine_id = machine_id
      @id = id
    end

    # Give Sai a task, or steer the running one. Returns a Turn at once. Sent while a turn is
    # running, the message steers that turn (+turn.queued+ is true).
    #
    # Any of +inputs+, +output_schema+ or +success_criteria+ (a string, or a list of Check) makes
    # the message structured: +wait+ then also returns the turn's record in +result.record+. A
    # structured message, +record_trajectory+ and +thinking_level+ (+off+, +low+, +medium+,
    # +high+, +xhigh+) are refused with ConflictError (+session_busy+) while a turn is running.
    # The same +idempotency_key+ again returns the earlier turn and sends nothing. +autonomous+
    # runs the turn without approval cards, as if "Trust for this task" had been answered.
    # @return [Turn]
    def send(message, model: nil, attachments: nil, inputs: nil, output_schema: nil, success_criteria: nil,
             idempotency_key: nil, record_trajectory: false, thinking_level: nil, autonomous: false)
      body = { "message" => message, "wait" => false }
      body["machineId"] = machine_id if machine_id && !machine_id.empty?
      body["sessionId"] = id if id && !id.empty?
      body["model"] = model if model && !model.empty?
      body["attachments"] = attachments.map(&:raw) if attachments && !attachments.empty?
      body["autonomous"] = true if autonomous
      options = {}
      options["inputs"] = inputs unless inputs.nil?
      options["output_schema"] = output_schema unless output_schema.nil?
      options["success_criteria"] = Check.list_to_api(success_criteria) unless success_criteria.nil?
      options["idempotency_key"] = idempotency_key unless idempotency_key.nil?
      options["recordTrajectory"] = true if record_trajectory
      options["thinkingLevel"] = thinking_level unless thinking_level.nil?
      body["options"] = options unless options.empty?
      structured = [inputs, output_schema, success_criteria].any? { |v| !v.nil? }
      d = Parse.obj(@http.json("POST", "/v1/agents/message", json: body))
      if Parse.truthy(d["idempotent_replay"])
        # The key was used before: this is that turn, and nothing was sent.
        record = TurnRecord.parse(d)
        self.id = record.session_id || id
        self.machine_id = record.machine_id.empty? ? machine_id : record.machine_id
        return Turn.new(self, @http, queued: false, id: record.id, structured: structured, replay: record)
      end
      session_id = Parse.str(d["sessionId"])
      if session_id.nil? || session_id.empty?
        # Handled without starting a task (e.g. a plain acknowledgement): the reply is in reply,
        # or in error on servers before reply existed.
        text = Parse.str(d["reply"]) || Parse.str(d["error"]) || ""
        return Turn.new(self, @http, queued: false, done: Turns.local_result(id || "", text))
      end
      self.id = session_id
      self.machine_id = d["machineId"] if d["machineId"].is_a?(String)
      Turn.new(self, @http, queued: Parse.truthy(d["queued"]), id: Parse.str(d["turnId"]), structured: structured)
    end

    # +send+ then +wait+: the answer, or where it stopped. Takes +send+'s options, plus
    # +on_approval:+ (or a block) and +timeout:+ and +poll_wait:+ as in Turn#wait.
    # @return [TurnResult]
    def run(message, on_approval: nil, timeout: nil, poll_wait: nil, **send_options, &block)
      send(message, **send_options).wait(on_approval: on_approval, timeout: timeout, poll_wait: poll_wait, &block)
    end

    # Stop the running turn. Pending approvals are denied.
    # @return [Boolean] false if nothing was running
    def abort
      return false if id.nil? || id.empty?

      d = @http.json("POST", "/v1/agents/abort", json: { "sessionId" => id })
      Parse.truthy(Parse.obj(d)["aborted"])
    end

    # Answer an approval (an Approval or its id): +yes+, +no+, or +task+ (allow for the rest of
    # the task). A +choice+ approval needs +selections+, one list of option values per question.
    # Raises LinkOnlyApprovalError (with +approval_url+) when only a browser can answer it.
    # @return [String] +approved+, +approved_task+ or +denied+
    def respond(approval, response = "yes", selections: nil)
      if approval.is_a?(Approval) && approval.is_link_only
        raise LinkOnlyApprovalError.new("This approval must be completed in a browser. Open approval.url.",
                                        status: 409, code: "link_only", body: { "approvalUrl" => approval.url })
      end
      body = { "approvalId" => approval.is_a?(Approval) ? approval.id : approval, "response" => response }
      body["selections"] = selections unless selections.nil?
      d = @http.json("POST", "/v1/agents/approve", json: body)
      Parse.str(Parse.obj(d)["status"]) || ""
    end

    def inspect
      "#<Sai::Session id=#{id.inspect} machine_id=#{machine_id.inspect}>"
    end
  end

  # One message's work. Iterate +events+ to watch it, or +wait+ for the result. +id+ is the turn
  # the message started, or the running turn it joined; nil when the message was answered
  # without one.
  class Turn
    POLL_WAIT = 30
    # Turns that failed for these reasons still have the agent's answer.
    ANSWERED_REASONS = %w[output_invalid criteria_not_met criteria_unchecked].freeze
    private_constant :ANSWERED_REASONS

    attr_reader :id, :queued, :session

    # @api private
    def initialize(session, http, queued:, done: nil, id: nil, structured: false, replay: nil)
      @session = session
      @http = http
      @queued = queued
      @last = done
      @id = id
      @structured = structured
      @replay = replay
      @cursor = nil
      # answered without starting a task, or an idempotent replay: no events to poll
      @local = !done.nil? || !replay.nil?
    end

    # +running+ until a poll says otherwise; see TURN_STATUSES.
    def status
      @last ? @last.status : "running"
    end

    # The last known state, or nil before the first poll.
    # @return [TurnResult, nil]
    def result
      @last
    end

    # Yield events until the turn is idle or errors, through +needs_approval+: answer with
    # +turn.respond(ev.approval, ...)+ inside the loop. Without +raw+, framing, reasoning and
    # tool-call frames are skipped. Without a block, returns an Enumerator.
    # @yieldparam event [Event]
    def events(raw: false, poll_wait: POLL_WAIT)
      return enum_for(:events, raw: raw, poll_wait: poll_wait) unless block_given?
      return if @local

      loop do
        page = poll(poll_wait)
        Parse.list(page["events"]).each do |e|
          ev = Event.parse(Parse.obj(e))
          yield ev if raw || ev.kind != "other"
        end
        break if %w[idle error].include?(page["status"])
      end
      nil
    end

    # Wait until the turn is done, or stops on an approval nobody answered. Without a handler,
    # returns with +status == "needs_approval"+ and the +approval+. With one (+on_approval:+ or a
    # block), its answer is sent and waiting continues: a response (+"yes"+, +"no"+, +"task"+),
    # a +[response, selections]+ pair for a choice, or nil to leave the approval to someone else
    # and keep waiting. For a structured message it then waits for the turn's record. +timeout+
    # (seconds) raises Timeout::Error with the turn still running; +poll_wait+ is the seconds the
    # server may hold one poll (it caps at 60).
    # @yieldparam approval [Approval]
    # @return [TurnResult]
    def wait(on_approval: nil, timeout: nil, poll_wait: nil, &block)
      handler = on_approval || block
      deadline = timeout.nil? ? nil : Util.monotonic + timeout
      if @replay
        record = @replay.done ? @replay : Turns.wait_record(@http, @replay.id, deadline)
        @last = replay_result(record, record.session_id || session.id || "")
        return @last
      end
      return @last if @local

      answered = {}
      loop do
        wait_s = poll_wait || POLL_WAIT
        if deadline
          left = deadline - Util.monotonic
          raise Timeout::Error, "Turn still #{status} after #{timeout}s (session #{session.id})." if left <= 0

          wait_s = [1, [wait_s, left.floor].min].max
        end
        page = poll(wait_s)
        if %w[idle error].include?(page["status"])
          @last.record = Turns.wait_record(@http, id, deadline) if @structured && id
          return @last
        end
        approval = @last&.approval
        next if page["status"] != "needs_approval" || approval.nil?
        return @last unless handler
        next if answered[approval.id]

        answer = handler.call(approval)
        answered[approval.id] = true
        next if answer.nil?

        response, selections = answer.is_a?(Array) ? answer : [answer, nil]
        begin
          session.respond(approval, response, selections: selections)
        rescue ConflictError
          # answered elsewhere or expired; the next poll shows the new state
        end
      end
    end

    # Answer an approval; see Session#respond.
    def respond(approval, response = "yes", selections: nil)
      session.respond(approval, response, selections: selections)
    end

    # Stop the running turn; see Session#abort.
    def abort
      session.abort
    end

    def inspect
      "#<Sai::Turn id=#{id.inspect} queued=#{queued} status=#{status.inspect}>"
    end

    private

    def poll(wait_s)
      page = nil
      loop do
        params = { "sessionId" => session.id || "", "wait" => wait_s, "since" => @cursor }
        page = Parse.obj(@http.json("GET", "/v1/agents/events", params: params, timeout: wait_s + 30))
        break
      rescue RateLimitError => e
        sleep(e.retry_after.nil? ? 30 : e.retry_after)
      end
      @cursor = Parse.str(page["cursor"]) || @cursor
      error = @last&.error
      error_code = @last&.error_code
      Parse.list(page["events"]).each do |e|
        next unless e.is_a?(Hash) && e["type"] == "error"

        error = e["errorText"] if e["errorText"].is_a?(String)
        error_code = e["code"] if e["code"].is_a?(String)
      end
      @last = TurnResult.new(
        status: Parse.str(page["status"]) || "running",
        text: Parse.str(page["text"]) || "",
        session_id: Parse.str(page["sessionId"]) || session.id || "",
        approval: page["approval"].is_a?(Hash) ? Approval.parse(page["approval"]) : nil,
        error: error,
        error_code: error_code,
        usage: Parse.usage(page["usage"]),
        session_usage: Parse.usage(page["sessionUsage"]),
        record: nil
      )
      page
    end

    # The result the live path would have returned for this finished turn, from its record.
    def replay_result(record, session_id)
      answer = record.raw_answer.nil? || record.raw_answer.empty? ? output_text(record.output) : record.raw_answer
      result = Turns.local_result(session_id, answer)
      if record.status == "failed" && !ANSWERED_REASONS.include?(record.reason_code || "")
        result.status = "error"
        result.text = ""
        result.error = record.raw_answer.nil? || record.raw_answer.empty? ? "The turn failed (#{record.reason_code || 'unknown'})." : record.raw_answer
        result.error_code = record.error_code
      end
      result.usage = record.usage
      result.record = record
      result
    end

    # +output+ as text: a plain message's answer as is, an +output_schema+ object as JSON.
    def output_text(output)
      return "" if output.nil?

      output.is_a?(String) ? output : JSON.generate(output)
    end
  end
end

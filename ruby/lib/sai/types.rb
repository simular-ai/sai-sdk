# frozen_string_literal: true

module Sai
  # @api private
  # Reading the API's JSON: the same coercions as the other SDKs.
  module Parse
    # Wire event type → SDK kind. Anything not listed is framing or internal detail.
    KINDS = {
      "data-progress" => "step",
      "text-delta" => "message",
      "data-approval-request" => "approval",
      "tool-output-error" => "tool_error",
      "error" => "error",
      "finish" => "finished"
    }.freeze
    # The last log lines of a run sent with an evaluation; the API takes 20 KB per result.
    EVAL_LOG_LINES = 30

    module_function

    def str(v)
      v.is_a?(String) ? v : nil
    end

    def num(v, default = 0)
      v.is_a?(Numeric) ? v : default
    end

    def num_or_nil(v)
      v.is_a?(Numeric) ? v : nil
    end

    def obj(v)
      v.is_a?(Hash) ? v : {}
    end

    def list(v)
      v.is_a?(Array) ? v : []
    end

    # JavaScript truthiness: nil, false, 0 and "" are false.
    def truthy(v)
      !(v.nil? || v == false || v == 0 || v == "")
    end

    def present(v)
      s = str(v)
      s.nil? || s.empty? ? nil : s
    end

    def usage(d)
      return nil unless d.is_a?(Hash)

      Usage.new(
        input_tokens: num(d["inputTokens"]),
        output_tokens: num(d["outputTokens"]),
        cache_read_tokens: num(d["cacheReadTokens"]),
        cache_write_tokens: num(d["cacheWriteTokens"]),
        cost_usd: num(d["costUsd"]),
        model_calls: num(d["modelCalls"]),
        by_model: obj(d["byModel"])
      )
    end
  end

  # The SDK's event kinds. +other+ only appears with +events(raw: true)+.
  EVENT_KINDS = %w[step message approval tool_error error finished other].freeze
  # Turn statuses: +running+ while polling, then one of the three others.
  TURN_STATUSES = %w[running idle needs_approval error].freeze
  # Turn record statuses, from +GET /v1/agents/turns/{id}+.
  TURN_RECORD_STATUSES = %w[running needs_input finalizing succeeded failed].freeze

  # Plan and spendable credit. +credits_usd+ is nil on the unlimited plan or when billing could
  # not be reached.
  Account = Struct.new(:user_id, :plan_id, :plan_title, :free, :unlimited, :credits_usd, :raw,
                       keyword_init: true) do
    def self.parse(d)
      plan = Parse.obj(d["plan"])
      credits = Parse.obj(d["credits"])
      new(
        user_id: Parse.str(d["userId"]) || "",
        plan_id: Parse.str(plan["id"]),
        plan_title: Parse.str(plan["title"]) || "",
        free: Parse.truthy(plan["free"]),
        unlimited: Parse.truthy(plan["unlimited"]),
        credits_usd: Parse.num_or_nil(credits["usd"]),
        raw: d
      )
    end
  end

  # A model a session can run on; +allowed+ says whether this plan may use it.
  Model = Struct.new(:id, :name, :provider, :tier, :cost_tier, :allowed, :raw, keyword_init: true) do
    def self.parse(d)
      id = Parse.str(d["id"]) || ""
      new(
        id: id,
        name: Parse.str(d["name"]) || id,
        provider: Parse.str(d["provider"]) || "",
        tier: Parse.str(d["tier"]) || "",
        cost_tier: Parse.str(d["costTier"]) || "",
        allowed: d.key?("allowed") ? Parse.truthy(d["allowed"]) : true,
        raw: d
      )
    end
  end

  # What stands in the way of driving a machine, as the Sai runtime on it last reported. Each field
  # is nil when nothing does, else a sentence for the user saying what is missing and how to fix it:
  # +can_see+ (screenshots show what is on screen), +can_use_accessibility+ (other apps'
  # accessibility trees can be read and acted on), +can_control+ (mouse, keyboard and element
  # actions reach other apps; needs what +can_use_accessibility+ needs). See
  # https://platform.simular.ai/documentation/organisations/tenant-machines#machine-capabilities.
  MachineCapabilities = Struct.new(:can_see, :can_use_accessibility, :can_control,
                                   keyword_init: true) do
    # nil unless +v+ is an object whose three answers are each a string or nil.
    def self.parse(v)
      return nil unless v.is_a?(Hash)
      return nil unless %w[canSee canUseAccessibility canControl].all? { |k| v.key?(k) && (v[k].nil? || v[k].is_a?(String)) }

      new(can_see: v["canSee"], can_use_accessibility: v["canUseAccessibility"],
          can_control: v["canControl"])
    end
  end

  # A computer Sai works on. +kind+ is +cloud+ or +own+; +state+ is +running+, +starting+,
  # +asleep+, +creating+ or +unknown+ (nil on servers that do not send it). +status+ is deprecated.
  # +capabilities+ is what stands in the way of driving it; nil for a cloud machine, before the
  # runtime has reported, from a runtime older than 0.1.3, when its check failed, and from older
  # servers.
  Machine = Struct.new(:id, :name, :kind, :online, :state, :status, :can_wake, :os, :capabilities,
                       :raw, keyword_init: true) do
    def self.parse(d)
      new(
        id: Parse.str(d["machineId"]) || "",
        name: Parse.str(d["name"]),
        kind: Parse.str(d["kind"]) || "",
        online: Parse.truthy(d["online"]),
        state: Parse.str(d["state"]),
        status: Parse.str(d["status"]),
        can_wake: Parse.truthy(d["canWake"]),
        os: Parse.str(d["os"]),
        capabilities: MachineCapabilities.parse(d["capabilities"]),
        raw: d
      )
    end
  end

  # A computer's live screen. +live_url+ is a page a person can open without a Simular sign-in
  # (nil where the server does not offer it), until +expires_at+ (Unix ms); +websocket_url+ is a
  # Guacamole tunnel for a viewer of your own. Both carry a token: keep them private.
  LiveView = Struct.new(:machine_id, :live_url, :expires_at, :websocket_url, :width, :height,
                        keyword_init: true)

  # A file uploaded with +sai.files.upload+. Pass it in +attachments:+.
  Attachment = Struct.new(:file_id, :name, :mime, :size, :raw, keyword_init: true) do
    def self.parse(d)
      new(
        file_id: Parse.str(d["fileId"]) || "",
        name: Parse.str(d["name"]) || "",
        mime: Parse.str(d["mime"]) || "",
        size: Parse.num(d["size"]),
        raw: d
      )
    end
  end

  # Sai is waiting for permission, or for an answer to a choice question. +type+ is +exec+,
  # +choice+, ...; a +choice+ needs +selections+ when approved. +is_link_only+: a human must
  # answer in a browser at +url+.
  Approval = Struct.new(:id, :title, :description, :type, :is_link_only, :url, :command, :questions,
                        :raw, keyword_init: true) do
    def self.parse(d)
      new(
        id: Parse.str(d["approvalId"]) || "",
        title: Parse.str(d["title"]) || "",
        description: Parse.str(d["description"]) || "",
        type: Parse.str(d["approvalType"]) || "",
        is_link_only: Parse.truthy(d["isLinkOnly"]),
        url: Parse.str(d["approvalUrl"]),
        command: Parse.str(d["command"]),
        questions: Parse.list(d["questions"]),
        raw: d
      )
    end

    def link_only?
      is_link_only
    end
  end

  # Tokens and cost of model calls.
  Usage = Struct.new(:input_tokens, :output_tokens, :cache_read_tokens, :cache_write_tokens,
                     :cost_usd, :model_calls, :by_model, keyword_init: true)

  # One thing that happened in a turn. +kind+ is the SDK's name (see EVENT_KINDS); +type+ is the
  # wire type. +code+ is set on errors such as +insufficient_credits+.
  Event = Struct.new(:kind, :type, :text, :approval, :code, :raw, keyword_init: true) do
    def self.parse(d)
      t = Parse.str(d["type"]) || ""
      data = Parse.obj(d["data"])
      text = nil
      approval = nil
      case t
      when "data-progress" then text = Parse.str(data["text"])
      when "text-delta", "reasoning-delta" then text = Parse.str(d["delta"])
      when "tool-output-error", "error" then text = Parse.str(d["errorText"])
      when "data-approval-request"
        if Parse.truthy(data["approvalId"])
          approval = Approval.parse(data)
          text = approval.title
        end
      end
      new(kind: Parse::KINDS[t] || "other", type: t, text: text, approval: approval,
          code: Parse.str(d["code"]), raw: d)
    end
  end

  # Where a turn stopped. +status+ is +idle+ (done: +text+ is the answer), +error+, or
  # +needs_approval+ (waiting on +approval+; answer it and call +wait+ again). +record+ is the
  # turn's record for a structured message.
  TurnResult = Struct.new(:status, :text, :session_id, :approval, :error, :error_code, :usage,
                          :session_usage, :record, keyword_init: true) do
    # Idle, and for a structured message, the turn succeeded.
    def ok
      status == "idle" && (record.nil? || record.ok)
    end
    alias_method :ok?, :ok
  end

  # One yes/no constraint a turn is checked against. +id+: letters, digits, +_+ or +-+.
  # +return_evidence+ also returns one sentence of evidence (an extra model call).
  Check = Struct.new(:id, :check, :return_evidence, keyword_init: true) do
    # @api private
    def self.to_api(c)
      return c if c.is_a?(String)

      h = c.is_a?(Check) ? c.to_h : c.to_h.transform_keys(&:to_s).transform_keys(&:to_sym)
      out = { "id" => h[:id], "check" => h[:check] }
      evidence = h.key?(:return_evidence) ? h[:return_evidence] : h[:returnEvidence]
      out["returnEvidence"] = evidence unless evidence.nil?
      out
    end

    # @api private
    def self.list_to_api(criteria)
      criteria.is_a?(String) ? criteria : criteria.map { |c| to_api(c) }
    end
  end

  # The verdict on one success criterion. +id+ is nil for a natural-language criteria; +score+
  # is set for checks only.
  Evidence = Struct.new(:id, :passed, :score, :evidence, keyword_init: true)

  # A turn's record. +status+ is one of TURN_RECORD_STATUSES. On +failed+, +reason_code+ says why.
  TurnRecord = Struct.new(:id, :session_id, :machine_id, :status, :output, :reason_code, :raw_answer,
                          :error_code, :output_errors, :evidence, :usage, :record_trajectory,
                          :trajectory_recorded, :template, :inputs, :replayed, :raw,
                          keyword_init: true) do
    def self.parse(d)
      status = Parse.str(d["status"]) || "running"
      trajectory = Parse.obj(d["trajectory"])
      new(
        id: Parse.str(d["turnId"]) || "",
        session_id: Parse.str(d["sessionId"]),
        machine_id: Parse.str(d["machineId"]) || "",
        status: status,
        output: d["output"],
        reason_code: Parse.str(d["reason_code"]),
        raw_answer: Parse.str(d["raw_answer"]),
        error_code: Parse.str(d["error_code"]),
        output_errors: Parse.list(d["output_errors"]),
        evidence: Parse.list(d["evidence"]).map do |e|
          e = Parse.obj(e)
          Evidence.new(id: Parse.str(e["id"]), passed: Parse.truthy(e["passed"]),
                       score: Parse.num_or_nil(e["score"]), evidence: Parse.str(e["evidence"]))
        end,
        usage: Parse.usage(d["usage"]),
        record_trajectory: Parse.truthy(d["recordTrajectory"]),
        trajectory_recorded: Parse.truthy(trajectory["recorded"]),
        template: Parse.str(d["template"]),
        inputs: d["inputs"].is_a?(Hash) ? d["inputs"] : nil,
        replayed: Parse.truthy(d["idempotent_replay"]),
        raw: d
      )
    end

    # +succeeded+ or +failed+.
    def done
      status == "succeeded" || status == "failed"
    end
    alias_method :done?, :done

    def ok
      status == "succeeded"
    end
    alias_method :ok?, :ok
  end

  # One step the agent took. Fetch its screen with +sai.turns.screenshot+.
  TrajectoryStep = Struct.new(:index, :final, :timestamp, :title, :code, :rationale, :error,
                              :has_screenshot, :raw, keyword_init: true) do
    def self.parse(d)
      new(
        index: Parse.num(d["index"]),
        final: Parse.truthy(d["final"]),
        timestamp: Parse.str(d["timestamp"]) || "",
        title: Parse.str(d["title"]),
        code: Parse.str(d["code"]),
        rationale: Parse.str(d["rationale"]),
        error: Parse.str(d["error"]),
        has_screenshot: Parse.truthy(d["screenshot"]),
        raw: d
      )
    end
  end

  # Why a block failed: +kind+ is +exception+, +timeout+ or +interrupted+.
  ExecError = Struct.new(:kind, :message, :stack, keyword_init: true)

  # What one Simulang block returned. A block that threw is still a result: check +error+.
  # +screenshot+ is the captured image as a binary String (+screenshot_mime_type+ says which).
  ExecResult = Struct.new(:result, :logs, :error, :screenshot, :screenshot_mime_type,
                          :screenshot_omitted, :variables, :duration_ms, :raw, keyword_init: true) do
    def self.parse(d)
      obs = Parse.obj(d["observations"])
      shot = Parse.obj(obs["screenshot"])
      err = Parse.truthy(d["error"]) ? Parse.obj(d["error"]) : nil
      b64 = Parse.str(shot["base64"])
      new(
        result: d["result"],
        logs: Parse.list(d["logs"]),
        error: err && ExecError.new(kind: Parse.str(err["kind"]) || "",
                                    message: Parse.str(err["message"]) || "",
                                    stack: Parse.str(err["stack"])),
        screenshot: b64.nil? || b64.empty? ? nil : b64.unpack1("m"),
        screenshot_mime_type: Parse.str(shot["mimeType"]),
        screenshot_omitted: Parse.truthy(obs["screenshotOmitted"]),
        variables: Parse.list(d["variables"]),
        duration_ms: Parse.num(d["durationMs"]),
        raw: d
      )
    end

    def ok
      error.nil?
    end
    alias_method :ok?, :ok

    # @deprecated Use +screenshot+; it is not always PNG.
    def screenshot_png
      screenshot
    end
  end

  # One input of learned code: a +{{name}}+ in the template and a key of +main+'s params.
  LearnParameter = Struct.new(:name, :default_value, :description, keyword_init: true)

  # How learned code did on one run, for +sai.learn.create(initial_code:, evaluations:)+.
  # +result+ is an ExecResult (its screenshot is not sent); +judgement+ a Judgement or its id.
  Evaluation = Struct.new(:inputs, :result, :judgement, :passed, :note, keyword_init: true) do
    # @api private
    def self.to_api(e)
      e = new(**e.to_h.transform_keys(&:to_sym)) unless e.is_a?(Evaluation)
      out = { "inputs" => e.inputs }
      if (r = e.result)
        run = { "result" => r.result, "logs" => r.logs.last(Parse::EVAL_LOG_LINES) }
        run["error"] = { "kind" => r.error.kind, "message" => r.error.message } if r.error
        out["result"] = run
      end
      unless e.judgement.nil?
        out["judgement"] = e.judgement.is_a?(String) ? e.judgement : e.judgement.id
      end
      out["passed"] = e.passed unless e.passed.nil?
      out["note"] = e.note unless e.note.nil?
      out
    end
  end

  # What a +reset+ did before a run or before the agent run. +kind+ is +code+ or +task+.
  LearnReset = Struct.new(:kind, :ok, :duration_ms, :turn_id, :error, keyword_init: true) do
    def self.parse(v)
      return nil unless v.is_a?(Hash)

      new(
        kind: Parse.str(v["kind"]) == "task" ? "task" : "code",
        ok: Parse.truthy(v["ok"]),
        duration_ms: Parse.num_or_nil(v["durationMs"]),
        turn_id: Parse.str(v["turnId"]),
        error: Parse.str(v["error"])
      )
    end
  end

  # One run of a version of the code in a learn job. +verdict+ is +passed+, +failed+, +error+,
  # +stopped+, or nil while the run is going.
  LearnRollout = Struct.new(:index, :verdict, :reset, :error, :result, :duration_ms, :judgement_id,
                            :summary, :continuation_turn_id, :continuation_timed_out,
                            keyword_init: true) do
    def self.parse(r)
      new(
        index: Parse.num(r["index"]),
        verdict: Parse.str(r["verdict"]),
        reset: LearnReset.parse(r["reset"]),
        error: Parse.str(r["error"]),
        result: r["result"],
        duration_ms: Parse.num_or_nil(r["durationMs"]),
        judgement_id: Parse.str(r["judgementId"]),
        summary: Parse.str(r["summary"]),
        continuation_turn_id: Parse.str(r["continuationTurnId"]),
        continuation_timed_out: Parse.truthy(r["continuationTimedOut"])
      )
    end
  end

  # One version of the code in a learn job and its runs. +index+ is 1-based.
  LearnIteration = Struct.new(:index, :learn_id, :changes, :passed, :runs, :rollouts,
                              keyword_init: true) do
    def self.parse(d)
      new(
        index: Parse.num(d["index"]),
        learn_id: Parse.str(d["learnId"]),
        changes: Parse.str(d["changes"]),
        passed: Parse.num(d["passed"]),
        runs: Parse.num(d["runs"]),
        rollouts: Parse.list(d["rollouts"]).map { |r| LearnRollout.parse(Parse.obj(r)) }
      )
    end
  end

  # How the returned code did when it was run, on +inputs+ only: +not_judged+, +passed+ or +failed+.
  LearnTestResult = Struct.new(:status, :passed_runs, :required_runs, :inputs, keyword_init: true)
  # While a job runs: the step it is on.
  LearnProgress = Struct.new(:step, :iteration, :rollout, keyword_init: true)
  # With +judge_initial_agent_run+: the judgement of the agent run.
  AgentJudgement = Struct.new(:judgement_id, :verdict, :summary, keyword_init: true)
  # Problems found in learned code. Code with +errors+ comes back +failed+.
  LearnValidation = Struct.new(:errors, :warnings, keyword_init: true)

  # The result of +sai.learn.create+: Simulang code made from recorded turns or an agent run, a
  # repair of code you sent, or a learn job. Run the code with +lease.run(learned, inputs)+.
  # +status+ is +succeeded+, +failed+, +running+ or +stopped+. +agent_run_end+ is how a job's agent
  # run ended when it gave no answer (nil when it answered): +time_limit+ (still converted),
  # +needs_input+ or the turn's +reason_code+, e.g. +agent_error+; every end but +time_limit+ stops
  # the job (+agent_failed+) before conversion. Research preview.
  LearnResult = Struct.new(:id, :mode, :status, :stop_reason, :message, :test_result, :progress,
                           :agent_turn_id, :agent_run_end, :agent_run_reset, :agent_judgement, :version, :iterations,
                           :title, :template, :parameters, :code, :output_schema, :validation,
                           :changes, :source_turns, :usage, :error, :replayed, :raw,
                           keyword_init: true) do
    def self.parse(d)
      v = Parse.obj(d["validation"])
      mode = Parse.str(d["mode"])
      t = Parse.truthy(d["testResult"]) ? Parse.obj(d["testResult"]) : nil
      p = Parse.truthy(d["progress"]) ? Parse.obj(d["progress"]) : nil
      aj = Parse.truthy(d["agentJudgement"]) ? Parse.obj(d["agentJudgement"]) : nil
      new(
        id: Parse.str(d["learnId"]) || "",
        mode: %w[heal policyIteration].include?(mode) ? mode : "convert",
        status: Parse.str(d["status"]) || "running",
        stop_reason: Parse.str(d["stopReason"]),
        message: Parse.str(d["message"]),
        test_result: t && LearnTestResult.new(
          status: Parse.str(t["status"]) || "not_judged",
          passed_runs: Parse.num(t["passedRuns"]),
          required_runs: Parse.num(t["requiredRuns"]),
          inputs: Parse.truthy(t["inputs"]) ? Parse.obj(t["inputs"]) : nil
        ),
        progress: p && LearnProgress.new(
          step: Parse.str(p["step"]) || "",
          iteration: Parse.num_or_nil(p["iteration"]),
          rollout: Parse.num_or_nil(p["rollout"])
        ),
        agent_turn_id: Parse.str(d["agentTurnId"]),
        agent_run_end: Parse.str(d["agentRunEnd"]),
        agent_run_reset: LearnReset.parse(d["agentRunReset"]),
        agent_judgement: aj && AgentJudgement.new(
          judgement_id: Parse.str(aj["judgementId"]) || "",
          verdict: Parse.str(aj["verdict"]) || "",
          summary: Parse.str(aj["summary"])
        ),
        version: Parse.num_or_nil(d["version"]),
        iterations: Parse.list(d["iterations"]).map { |i| LearnIteration.parse(Parse.obj(i)) },
        title: Parse.str(d["title"]),
        template: Parse.str(d["template"]),
        parameters: Parse.list(d["parameters"]).map do |x|
          x = Parse.obj(x)
          LearnParameter.new(name: Parse.str(x["name"]) || "",
                             default_value: Parse.str(x["defaultValue"]) || "",
                             description: Parse.str(x["description"]))
        end,
        code: Parse.str(d["code"]) || "",
        output_schema: Parse.truthy(d["outputSchema"]) ? Parse.obj(d["outputSchema"]) : nil,
        validation: LearnValidation.new(errors: Parse.list(v["errors"]), warnings: Parse.list(v["warnings"])),
        changes: Parse.str(d["changes"]),
        source_turns: Parse.list(d["sourceTurns"]),
        usage: Parse.usage(d["usage"]),
        error: Parse.str(d["error"]),
        replayed: Parse.truthy(d["idempotent_replay"]),
        raw: d
      )
    end

    def ok
      status == "succeeded"
    end
    alias_method :ok?, :ok
  end

  # One run of a learn job's code, from +sai.learn.rollout+: +run+ is what it returned and
  # logged, +judgement+ the judge's record of it.
  LearnRun = Struct.new(:learn_id, :iteration, :rollout, :run, :judgement, :raw, keyword_init: true) do
    def self.parse(d)
      new(
        learn_id: Parse.str(d["learnId"]) || "",
        iteration: Parse.num(d["iteration"]),
        rollout: Parse.num(d["rollout"]),
        run: Parse.obj(d["run"]),
        judgement: Parse.truthy(d["judgement"]) ? Parse.obj(d["judgement"]) : nil,
        raw: d
      )
    end
  end

  # The verdict on one criterion of a judgement: +passed+, +failed+ or +unverifiable+.
  CriterionResult = Struct.new(:id, :check, :verdict, :score, :evidence, keyword_init: true)

  # The result of +sai.judge.create+. It never changes the turns it judged. Research preview.
  Judgement = Struct.new(:id, :verdict, :summary, :task, :criteria, :turns, :usage, :replayed, :raw,
                         keyword_init: true) do
    def self.parse(d)
      new(
        id: Parse.str(d["judgementId"]) || "",
        verdict: Parse.str(d["verdict"]),
        summary: Parse.str(d["summary"]),
        task: Parse.str(d["task"]),
        criteria: Parse.list(d["criteria"]).map do |c|
          c = Parse.obj(c)
          CriterionResult.new(id: Parse.str(c["id"]), check: Parse.str(c["check"]) || "",
                              verdict: Parse.str(c["verdict"]) || "unverifiable",
                              score: Parse.num_or_nil(c["score"]), evidence: Parse.str(c["evidence"]))
        end,
        turns: Parse.list(d["turns"]),
        usage: Parse.usage(d["usage"]),
        replayed: Parse.truthy(d["idempotent_replay"]),
        raw: d
      )
    end

    def ok
      verdict == "passed"
    end
    alias_method :ok?, :ok
  end

  # Who the key or token acts as. +auth_type+ is +apiKey+ for a key, +firebase+ for a signed-in
  # session or a Tenant token; +tenant_id+ and +org_id+ are set for a Tenant token.
  AuthInfo = Struct.new(:user_id, :auth_type, :tenant_id, :org_id, :raw, keyword_init: true) do
    def self.parse(d)
      new(user_id: Parse.str(d["userId"]) || "", auth_type: Parse.str(d["authType"]) || "",
          tenant_id: Parse.str(d["tenantId"]), org_id: Parse.str(d["orgId"]), raw: d)
    end
  end

  # A session on a computer, from +sai.sessions.list+. +active+: the next message goes to it.
  SessionSummary = Struct.new(:id, :title, :updated_at, :active, :raw, keyword_init: true) do
    def self.parse(d)
      new(id: Parse.str(d["sessionId"]) || "", title: Parse.str(d["title"]) || "",
          updated_at: Parse.num(d["updatedAt"]), active: Parse.truthy(d["active"]), raw: d)
    end
  end

  # One of your customers under an Organisation. Times are Unix milliseconds;
  # +cloud_machine_limit+ nil means no limit. +own_computer_access+: whether learn jobs and direct
  # control may run code on its enrolled machines; nil from +list+ and from older servers.
  Tenant = Struct.new(:id, :name, :external_id, :metadata, :status, :created_at, :disabled_at,
                      :machine_count, :cloud_machine_limit, :residential_proxy, :cloud_machine_count,
                      :own_computer_access, :raw, keyword_init: true) do
    def self.parse(d)
      new(
        id: Parse.str(d["tenantId"]) || "",
        name: Parse.str(d["name"]) || "",
        external_id: Parse.str(d["externalId"]),
        metadata: Parse.obj(d["metadata"]),
        status: Parse.str(d["status"]) || "",
        created_at: Parse.num(d["createdAt"]),
        disabled_at: Parse.num_or_nil(d["disabledAt"]),
        machine_count: Parse.num(d["machineCount"]),
        cloud_machine_limit: Parse.num_or_nil(d["cloudMachineLimit"]),
        residential_proxy: [true, false].include?(d["residentialProxy"]) ? d["residentialProxy"] : nil,
        cloud_machine_count: Parse.num_or_nil(d["cloudMachineCount"]),
        own_computer_access: [true, false].include?(d["ownComputerAccess"]) ? d["ownComputerAccess"] : nil,
        raw: d
      )
    end
  end

  # One page of Tenants. Pass +next_cursor+ as +cursor:+ for the next; nil on the last page.
  TenantPage = Struct.new(:tenants, :next_cursor, keyword_init: true)

  # A Tenant's computer: enrolled, or a cloud machine Sai hosts. +kind+ is +enrolled+ or +cloud+;
  # +state+ is +online+/+offline+ (enrolled) or +provisioning+, +ready+, +starting+,
  # +hibernated+, +deleting+ or +failed+ (cloud). +capabilities+ is what stands in the way of
  # driving it; nil for a cloud machine, before the runtime has reported, from a runtime older than
  # 0.1.3, when its check failed, and from older servers.
  TenantMachine = Struct.new(:id, :name, :platform, :status, :online, :last_seen, :runtime_version,
                             :kind, :state, :machine_class, :created_at, :capabilities, :raw,
                             keyword_init: true) do
    def self.parse(d)
      # Servers before cloud machines send online and status and no kind or state.
      state = Parse.present(d["state"]) || (Parse.truthy(d["online"]) ? "online" : "offline")
      new(
        id: Parse.str(d["machineId"]) || "",
        name: Parse.str(d["name"]),
        platform: Parse.str(d["platform"]),
        status: Parse.str(d["status"]) || "",
        online: d.key?("online") ? Parse.truthy(d["online"]) : %w[online ready].include?(state),
        last_seen: Parse.num_or_nil(d["lastSeen"]),
        runtime_version: Parse.str(d["runtimeVersion"]),
        kind: d["kind"] == "cloud" ? "cloud" : "enrolled",
        state: state,
        machine_class: Parse.str(d["machineClass"]),
        created_at: Parse.num_or_nil(d["createdAt"]),
        capabilities: MachineCapabilities.parse(d["capabilities"]),
        raw: d
      )
    end
  end

  # A single-use code that enrolls one computer into a Tenant. Treat +token+ as a secret.
  Enrollment = Struct.new(:token, :expires_at, :raw, keyword_init: true) do
    def self.parse(d)
      new(token: Parse.str(d["enrollmentToken"]) || "", expires_at: Parse.num(d["expiresAt"]), raw: d)
    end
  end

  # A one-hour token that acts as a Tenant: pass +token+ as +Sai::Client.new(api_key:)+.
  TenantToken = Struct.new(:token, :expires_at, :tenant_id, :raw, keyword_init: true) do
    def self.parse(d)
      new(token: Parse.str(d["token"]) || "", expires_at: Parse.num(d["expiresAt"]),
          tenant_id: Parse.str(d["tenantId"]) || "", raw: d)
    end
  end

  # One Tenant's spend in an Organisation usage report. +by_category+ maps a kind of spend
  # (+token+, +compute+) to a CategoryUsage.
  TenantUsage = Struct.new(:tenant_id, :name, :external_id, :cost_cents, :by_category, keyword_init: true)
  # Spend of one category.
  CategoryUsage = Struct.new(:cost_cents, keyword_init: true)

  # One period of an Organisation usage report, or the whole range (+totals+, whose +bucket+ is
  # nil). +by_tenant+ is keyed by Tenant id.
  UsageBucket = Struct.new(:bucket, :cost_cents, :by_tenant, keyword_init: true) do
    def self.parse(d)
      by_tenant = {}
      Parse.obj(d["byTenant"]).each do |key, v|
        t = Parse.obj(v)
        by_category = {}
        Parse.obj(t["byCategory"]).each do |cat, c|
          by_category[cat] = CategoryUsage.new(cost_cents: Parse.num(Parse.obj(c)["costCents"]))
        end
        by_tenant[key] = TenantUsage.new(
          tenant_id: Parse.str(t["tenantId"]) || key,
          name: Parse.str(t["name"]),
          external_id: Parse.str(t["externalId"]),
          cost_cents: Parse.num(t["costCents"]),
          by_category: by_category
        )
      end
      new(bucket: Parse.str(d["bucket"]), cost_cents: Parse.num(d["costCents"]), by_tenant: by_tenant)
    end
  end

  # What an Organisation is charged, per Tenant, from +sai.usage.get+.
  OrgUsage = Struct.new(:granularity, :from, :to, :totals, :buckets, :raw, keyword_init: true) do
    def self.parse(d)
      new(
        granularity: Parse.str(d["granularity"]) || "",
        from: Parse.str(d["from"]) || "",
        to: Parse.str(d["to"]) || "",
        totals: UsageBucket.parse(Parse.obj(d["totals"])),
        buckets: Parse.list(d["buckets"]).map { |b| UsageBucket.parse(Parse.obj(b)) },
        raw: d
      )
    end
  end

  # What one of a Tenant's sessions spent on AI calls: in a date range, or so far when looked up
  # by +session_ids+. +cost_usd+ is in US dollars, not rounded to cents; it and +model_calls+ are
  # nil only from a +session_ids+ lookup, when the session can't be read in full right now (never
  # 0 for that), and +settled+ is then false. +first_day+ and +last_day+ are the UTC days
  # (+YYYY-MM-DD+) the session's spend was first and last counted, over its whole life; empty from
  # a +session_ids+ lookup. +settled+, from a +session_ids+ lookup: true once the session's latest
  # task has ended and every charge for it has come in; nil on a list page.
  SessionSpend = Struct.new(:session_id, :title, :cost_usd, :model_calls, :first_day, :last_day, :settled,
                            keyword_init: true)

  # One page of +sai.usage.sessions+. A page can be empty and still have a +next_cursor+.
  # +data_through+ (ISO 8601): the figures are complete up to this time; nil when unknown, and from
  # a +session_ids+ lookup. +as_of+ (ISO 8601), from a +session_ids+ lookup: when the figures were
  # read; nil on a list page.
  SessionSpendPage = Struct.new(:sessions, :next_cursor, :data_through, :raw, :as_of, keyword_init: true) do
    def self.parse(d)
      sessions = Parse.list(d["sessions"]).map do |s|
        s = Parse.obj(s)
        SessionSpend.new(
          session_id: Parse.str(s["sessionId"]) || "",
          title: Parse.present(s["title"]),
          cost_usd: Parse.num_or_nil(s["costUsd"]),
          model_calls: Parse.num_or_nil(s["modelCalls"]),
          first_day: Parse.str(s["firstDay"]) || "",
          last_day: Parse.str(s["lastDay"]) || "",
          settled: [true, false].include?(s["settled"]) ? s["settled"] : nil
        )
      end
      new(sessions: sessions, next_cursor: Parse.str(d["nextCursor"]),
          data_through: Parse.str(d["dataThrough"]), raw: d, as_of: Parse.str(d["asOf"]))
    end
  end
end

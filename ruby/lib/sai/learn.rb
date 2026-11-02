# frozen_string_literal: true

require "timeout"

module Sai
  # Learn (research preview): turn recorded turns, or a task the agent does first, into Simulang
  # code you own; repair that code; run, judge and repair it on a machine until it passes.
  class Learn
    # A conversion is two model calls of up to a minute or two each, plus one retry.
    TIMEOUT = 600
    # How often +wait+ reads a learn job; a job's steps take tens of seconds to minutes.
    POLL_INTERVAL = 10
    # Options sent as given, by their API name.
    PASSTHROUGH = {
      history: "history",
      runs_without_reset: "runsWithoutReset",
      max_iterations: "maxIterations",
      rollouts: "rollouts",
      reset: "reset",
      judge_initial_agent_run: "judgeInitialAgentRun",
      continue_with_agent: "continueWithAgent",
      rollout_minutes: "rolloutMinutes",
      agent_run_minutes: "agentRunMinutes",
      continuation_minutes: "continuationMinutes",
      max_job_minutes: "maxJobMinutes",
      model: "model",
      idempotency_key: "idempotency_key"
    }.freeze
    private_constant :PASSTHROUGH

    # @api private
    def initialize(http)
      @http = http
    end

    # Make Simulang code, and optionally run, judge and repair it on a machine.
    #
    # - +create([turn])+: code from recorded turns (one session, each sent with
    #   +record_trajectory: true+). Answers with the code.
    # - +create(initial_code:, guidance: or evaluations:)+: a repair. Answers with the code.
    # - +create(turns, max_iterations: 3)+ or +create(task_template:, inputs:, max_iterations: 3)+:
    #   a job on the machine. Answers at once with +status == "running"+; read it with +wait+.
    #
    # +criteria+ is a sentence or a list of Check; +reset+ is +{ code: }+ or +{ task: }+;
    # +evaluations+ a list of Evaluation. +template+ and +feedback+ are the old names of
    # +task_template+ and +guidance+. +timeout+ is in seconds.
    # @return [LearnResult]
    def create(turns = [], task_template: nil, template: nil, inputs: nil, initial_code: nil, evaluations: nil,
               guidance: nil, feedback: nil, machine: nil, criteria: nil, timeout: TIMEOUT, **options)
      unknown = options.keys - PASSTHROUGH.keys
      raise ArgumentError, "unknown keyword#{'s' if unknown.length > 1}: #{unknown.join(', ')}" unless unknown.empty?

      body = { "turns" => turns.map { |t| Util.turn_id(t) } }
      # The old names go out as sent, so code that uses them keeps working with an older API.
      if !task_template.nil? then body["taskTemplate"] = task_template
      elsif !template.nil? then body["template"] = template
      end
      body["inputs"] = inputs unless inputs.nil?
      body["initialCode"] = initial_code unless initial_code.nil?
      body["evaluations"] = evaluations.map { |e| Evaluation.to_api(e) } if evaluations
      if !guidance.nil? then body["guidance"] = guidance
      elsif !feedback.nil? then body["feedback"] = feedback
      end
      body["machineId"] = Util.id_of(machine) unless machine.nil?
      body["criteria"] = Check.list_to_api(criteria) unless criteria.nil?
      PASSTHROUGH.each { |k, name| body[name] = options[k] unless options[k].nil? }
      LearnResult.parse(Parse.obj(@http.json("POST", "/v1/agents/learn", json: body, timeout: timeout)))
    end

    # A learn call's result, or a job's progress so far.
    # @return [LearnResult]
    def get(learn_id)
      LearnResult.parse(Parse.obj(@http.json("GET", "/v1/agents/learn/#{Util.q(learn_id)}")))
    end

    # Read a learn job (a LearnResult or its id) until it ends (+succeeded+, +failed+ or
    # +stopped+), every +poll_interval+ seconds. +timeout+ (seconds) raises Timeout::Error with the
    # job still running; it keeps running.
    # @return [LearnResult]
    def wait(job, timeout: nil, poll_interval: POLL_INTERVAL)
      learn_id = Util.id_of(job)
      deadline = timeout.nil? ? nil : Util.monotonic + timeout
      loop do
        begin
          r = get(learn_id)
        rescue RateLimitError => e
          sleep(e.retry_after.nil? ? 30 : e.retry_after)
          next
        end
        return r if r.status != "running"
        raise Timeout::Error, "Learn job #{learn_id} is still running." if deadline && Util.monotonic + poll_interval > deadline

        sleep(poll_interval)
      end
    end

    # Stop a learn job at once, whatever step it is on. It keeps the last complete results.
    # @return [nil]
    def cancel(job)
      @http.json("POST", "/v1/agents/learn/#{Util.q(Util.id_of(job))}/cancel")
      nil
    end

    # One run of a learn job's code: what it returned and logged, and its judgement.
    # @return [LearnRun]
    def rollout(job, iteration, rollout)
      path = "/v1/agents/learn/#{Util.q(Util.id_of(job))}/iterations/#{iteration}/rollouts/#{rollout}"
      LearnRun.parse(Parse.obj(@http.json("GET", path)))
    end
  end

  # Judge recorded turns against new criteria (research preview).
  class Judge
    TIMEOUT = 180

    # @api private
    def initialize(http)
      @http = http
    end

    # Judge recorded +turns+ (one session, as one task) against +criteria+: a sentence for a model
    # to judge, or a list of Check. Nothing runs again, and the turns do not change. +task+
    # defaults to the first turn's message.
    # @return [Judgement]
    def create(turns, criteria, task: nil, idempotency_key: nil, timeout: TIMEOUT)
      body = { "turns" => turns.map { |t| Util.turn_id(t) }, "criteria" => Check.list_to_api(criteria) }
      body["task"] = task unless task.nil?
      body["idempotency_key"] = idempotency_key unless idempotency_key.nil?
      Judgement.parse(Parse.obj(@http.json("POST", "/v1/agents/judge", json: body, timeout: timeout)))
    end

    # @return [Judgement]
    def get(judgement_id)
      Judgement.parse(Parse.obj(@http.json("GET", "/v1/agents/judge/#{Util.q(judgement_id)}")))
    end
  end
end

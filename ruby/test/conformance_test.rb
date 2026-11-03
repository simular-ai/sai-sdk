# frozen_string_literal: true

require_relative "test_helper"

# The shared conformance suite (../../conformance/README.md): each case's steps become calls on
# this SDK, against the mock server, which checks the requests and the outcomes.
class ConformanceTest < Minitest::Test
  CASES = Dir[File.join(CONFORMANCE, "cases", "*.json")].sort.flat_map { |f| JSON.parse(File.read(f))["cases"] }

  # Positional arguments of each client call, in order; every other argument is a keyword.
  POSITIONAL = {
    "machines.get" => %w[machine_id],
    "machines.live" => %w[machine],
    "machines.revoke_live" => %w[machine],
    "sessions.resume" => %w[session_id],
    "turns.get" => %w[turn],
    "turns.wait" => %w[turn],
    "turns.trajectory" => %w[turn],
    "turns.screenshot" => %w[turn index],
    "learn.create" => %w[turns],
    "learn.get" => %w[learn_id],
    "learn.cancel" => %w[job],
    "learn.rollout" => %w[job iteration rollout],
    "judge.create" => %w[turns criteria],
    "judge.get" => %w[judgement_id],
    "usage.sessions" => %w[tenant],
    "tenants.create" => %w[name],
    "tenants.get" => %w[tenant],
    "tenants.update" => %w[tenant],
    "tenants.delete" => %w[tenant],
    "tenants.create_enrollment" => %w[tenant],
    "tenants.token" => %w[tenant],
    "tenants.client" => %w[tenant],
    "tenant_machines.create" => %w[tenant],
    "tenant_machines.list" => %w[tenant],
    "tenant_machines.get" => %w[tenant machine_id],
    "tenant_machines.delete" => %w[tenant machine],
    "tenant_machines.revoke" => %w[tenant machine]
  }.freeze

  def self.server
    @server ||= MockServer.new
  end

  CASES.each do |c|
    define_method("test_#{c['id']}") { run_case(c) }
  end

  def run_case(c)
    server = self.class.server
    server.control("start", { "case" => c["id"] })
    opts = c["client"] || {}
    sai = Sai::Client.new(api_key: opts.fetch("api_key", "sapi_test"), base_url: server.url,
                          org_id: opts.fetch("org_id", ""), version_tag: opts["version_tag"])
    saved = { "client" => sai }
    c["steps"].each_with_index do |step, index|
      outcome = begin
        value = invoke(saved, step)
        saved[step["save"]] = step.key?("pick") ? pick(value, step["pick"]) : value if step["save"]
        { "result" => project(value) }
      rescue StandardError, Timeout::Error => e
        { "error" => project_error(e) }
      end
      server.control("step", { "index" => index }.merge(outcome))
    end
    assert_equal [], server.control("finish")["failures"]
  end

  # ─── Calls ───────────────────────────────────────────────────────────────────

  def invoke(saved, step)
    first, *rest = step["call"].split(".")
    target, method = saved.key?(first) && first != "client" ? [saved[first], rest.join(".")] : [saved["client"], step["call"]]
    a = resolve(saved, step["args"] || {})
    case target
    when Sai::Client then call_client(target, method, a)
    when Sai::Session then call_session(target, method, a)
    when Sai::Turn then call_turn(target, method, a)
    when Sai::ControlLease then call_lease(target, method, a)
    else raise "no target for #{step['call']}"
    end
  end

  def resolve(saved, v)
    case v
    when Array then v.map { |x| resolve(saved, x) }
    when Hash
      return saved.fetch(v["$ref"]) if v["$ref"].is_a?(String)

      v.transform_values { |x| resolve(saved, x) }
    else v
    end
  end

  def pick(value, path)
    path.split(".").reduce(value) { |v, part| v.is_a?(Array) ? v[Integer(part)] : v.public_send(part) }
  end

  def kwargs(a, *except)
    a.reject { |k, _| except.include?(k) }.transform_keys(&:to_sym)
  end

  def handler(a)
    return nil unless a["on_approval"]

    answers = a["on_approval"]["answers"].dup
    ->(_approval) { answers.shift }
  end

  def call_client(sai, method, a)
    case method
    when "control.open" then return sai.control.open(machine: a["machine"])
    when "files.upload" then return sai.files.upload(data: a["data_base64"].unpack1("m"), name: a["name"])
    when "learn.wait"
      kw = a.key?("poll_ms") ? { poll_interval: a["poll_ms"] / 1000.0 } : {}
      return sai.learn.wait(a["job"], **kw)
    end
    resource, name = method.split(".")
    positional = POSITIONAL.fetch(method, [])
    sai.public_send(resource).public_send(name, *positional.map { |k| a[k] }, **kwargs(a, *positional))
  end

  def call_session(s, method, a)
    case method
    when "send" then s.send(a["message"], **kwargs(a, "message"))
    when "run" then s.run(a["message"], **kwargs(a, "message", "on_approval"), on_approval: handler(a))
    when "abort" then s.abort
    when "respond" then respond(s, a)
    else raise "unknown call Session.#{method}"
    end
  end

  def call_turn(t, method, a)
    case method
    when "events" then t.events(**kwargs(a)).to_a
    when "wait" then t.wait(**kwargs(a, "on_approval"), on_approval: handler(a))
    when "respond" then respond(t, a)
    when "abort" then t.abort
    else raise "unknown call Turn.#{method}"
    end
  end

  def respond(target, a)
    args = [a["approval"]]
    args << a["response"] if a.key?("response")
    target.respond(*args, **kwargs(a, "approval", "response"))
  end

  def call_lease(lease, method, a)
    case method
    when "exec" then lease.exec(a["code"], **kwargs(a, "code"))
    when "run" then lease.run(a["learned"], a["inputs"] || {}, **kwargs(a, "learned", "inputs"))
    when "shell" then lease.shell(a["command"], **kwargs(a, "command"))
    when "read_file" then lease.read_file(a["path"])
    when "write_file" then lease.write_file(a["path"], a["text"])
    when "screenshot", "interrupt", "get", "close" then lease.public_send(method)
    else raise "unknown call ControlLease.#{method}"
    end
  end

  # ─── Projection ──────────────────────────────────────────────────────────────

  # Computed properties the projection includes.
  PROPERTIES = %i[ok done].freeze

  def project(v)
    case v
    when Sai::Client then {}
    when Sai::Session then { "id" => v.id, "machine_id" => v.machine_id }
    when Sai::Turn then { "id" => v.id, "queued" => v.queued, "status" => v.status }
    when Sai::ControlLease then { "machine_id" => v.machine_id, "idle_timeout_sec" => v.idle_timeout_sec }
    when String then v.encoding == Encoding::BINARY ? { "$base64" => [v].pack("m0") } : v
    when Array then v.map { |x| project(x) }
    when Hash then v.to_h { |k, x| [k.to_s, project(x)] }
    when Struct
      out = {}
      v.each_pair { |k, x| out[k.to_s] = project(x) unless k == :raw }
      PROPERTIES.each { |p| out[p.to_s] = v.public_send(p) if !v.members.include?(p) && v.respond_to?(p) }
      out
    else v
    end
  end

  def project_error(err)
    return { "class" => err.class.name, "message" => err.message } unless err.is_a?(Sai::Error)

    out = {
      "class" => err.instance_of?(Sai::Error) ? "SaiError" : err.class.name.delete_prefix("Sai::"),
      "status" => err.status,
      "code" => err.code,
      "message" => err.message,
      "retry_after" => err.retry_after,
      "body" => err.body
    }
    out["approval_url"] = err.approval_url if err.is_a?(Sai::LinkOnlyApprovalError)
    out["resets_at"] = err.resets_at if err.is_a?(Sai::SpendCapReachedError)
    out["kind"] = err.kind if err.is_a?(Sai::BlockError)
    out
  end
end

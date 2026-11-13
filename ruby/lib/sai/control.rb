# frozen_string_literal: true

require "json"

module Sai
  # Direct control: drive a computer with Simulang. No agent. A lease on the machine: at
  # most one per machine. Research preview; model calls the code makes are billed as usual.
  class Control
    OPEN_TIMEOUT = 240

    # @api private
    def initialize(http)
      @http = http
    end

    # Take a computer (a Machine or its id). Returns once the lease holds it, up to about
    # three minutes when a Sai task holds it or it has to start. Sai's tasks on that computer wait
    # until the lease is closed. With a block, yields the lease, closes it after, and returns the
    # block's value.
    # @yieldparam lease [ControlLease]
    # @return [ControlLease]
    def open(machine:)
      machine_id = Util.id_of(machine)
      d = Parse.obj(@http.json("POST", ControlLease.path(machine_id), timeout: OPEN_TIMEOUT))
      lease = ControlLease.new(@http, machine_id, Parse.num(d["expiresAfterIdleSec"]))
      return lease unless block_given?

      begin
        yield lease
      ensure
        lease.close
      end
    end
  end

  # The result of ControlLease#shell.
  ShellResult = Struct.new(:stdout, :stderr, :exit_code, :timed_out, keyword_init: true)

  # A lease on a computer. Close it when done: Sai's tasks on that computer wait until then.
  class ControlLease
    attr_reader :machine_id, :idle_timeout_sec

    # @api private
    def self.path(machine_id)
      "/v1/machines/#{Util.q(machine_id)}/control"
    end

    # @api private
    def initialize(http, machine_id, idle_timeout_sec)
      @http = http
      @machine_id = machine_id
      @idle_timeout_sec = idle_timeout_sec
      @path = self.class.path(machine_id)
      @closed = false
    end

    # Run one Simulang (JavaScript) block. Use +var+ for anything the next block needs. A block
    # that throws, times out or is interrupted still returns: check +result.error+. Raises
    # GoneError once the lease has ended: open again.
    # @return [ExecResult]
    def exec(code, timeout_ms: nil)
      body = { "code" => code }
      body["timeoutMs"] = timeout_ms unless timeout_ms.nil?
      d = @http.json("POST", "#{@path}/exec", json: body, timeout: ((timeout_ms || 120_000) + 45_000) / 1000.0)
      ExecResult.parse(Parse.obj(d))
    end

    # Run code from +sai.learn.create+: its +main+ with +inputs+ over the parameters' defaults.
    # +main+'s return value is +result.result+. A string runs as code with +inputs+ as is.
    # @return [ExecResult]
    def run(learned, inputs = {}, timeout_ms: nil)
      code = learned.is_a?(String) ? learned : learned.code
      args = learned.is_a?(String) ? {} : learned.parameters.to_h { |p| [p.name, p.default_value] }
      inputs.each { |k, v| args[k.to_s] = v }
      exec("#{code}\nawait main(#{JSON.generate(args)})", timeout_ms: timeout_ms)
    end

    # Run a shell command.
    # @return [ShellResult]
    def shell(command, cwd: nil, timeout_ms: nil)
      args = { "command" => command }
      args["cwd"] = cwd if cwd && !cwd.empty?
      r = exec("await machine.exec(#{JSON.generate(args)})", timeout_ms: timeout_ms)
      raise_on_block_error(r)
      d = Parse.obj(r.result)
      ShellResult.new(stdout: d["stdout"], stderr: d["stderr"], exit_code: d["exitCode"], timed_out: d["timedOut"])
    end

    # @return [String]
    def read_file(path)
      r = exec("await machine.readFile(#{JSON.generate({ 'path' => path })})")
      raise_on_block_error(r)
      r.result
    end

    # @return [nil]
    def write_file(path, text)
      r = exec("await machine.writeToFile(#{JSON.generate({ 'path' => path, 'text' => text, 'overwrite' => true })})")
      raise_on_block_error(r)
      nil
    end

    # The whole screen as image bytes (usually JPEG; use +exec+ for the MIME type). Needs the
    # computer's screen-capture service; raises BlockError where it is off.
    # @return [String] a binary String
    def screenshot
      r = exec("var __sai_page = await machine.pageContent(); null")
      raise_on_block_error(r)
      unless r.screenshot
        raise BlockError.new("exception", r.screenshot_omitted ? "screenshot too large to return" : "no screenshot")
      end

      r.screenshot
    end

    # Stop the running block at its next step.
    # @return [Boolean] false if nothing was running
    def interrupt
      d = @http.json("POST", "#{@path}/interrupt")
      Parse.truthy(Parse.obj(d)["interrupted"])
    end

    # The lease's state: +{ "status" => "open"|"closed", "closedReason" => ..., ... }+.
    # @return [Hash]
    def get
      @http.json("GET", @path)
    end

    # Clear the REPL and release the computer. Safe to call twice.
    # @return [nil]
    def close
      return if @closed

      begin
        @http.request("DELETE", @path)
      rescue GoneError
        # already ended
      end
      @closed = true
      nil
    end

    def inspect
      "#<Sai::ControlLease machine_id=#{machine_id.inspect} idle_timeout_sec=#{idle_timeout_sec}>"
    end

    private

    def raise_on_block_error(r)
      raise BlockError.new(r.error.kind, r.error.message) if r.error
    end
  end
end

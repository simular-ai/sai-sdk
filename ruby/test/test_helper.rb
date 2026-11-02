# frozen_string_literal: true

require "json"
require "net/http"
require "minitest/autorun"
require "sai"

ROOT = File.expand_path("../..", __dir__)
CONFORMANCE = File.join(ROOT, "conformance")

# The shared mock Sai API (../../conformance/server.mjs). It exits when its stdin closes, so it
# goes with this process.
class MockServer
  attr_reader :url

  def initialize
    @io = IO.popen(["node", File.join(CONFORMANCE, "server.mjs")], "r+")
    line = @io.gets.to_s
    raise "mock server did not start: #{line.inspect}" unless line.start_with?("SAI_MOCK_URL=")

    @url = line.strip.delete_prefix("SAI_MOCK_URL=")
    at_exit { stop }
  end

  def control(path, body = {})
    uri = URI("#{@url}/__mock/#{path}")
    res = Net::HTTP.post(uri, JSON.generate(body), "Content-Type" => "application/json")
    JSON.parse(res.body)
  end

  def stop
    Process.kill("TERM", @io.pid)
    @io.close
  rescue Errno::ESRCH, IOError
    nil
  end
end

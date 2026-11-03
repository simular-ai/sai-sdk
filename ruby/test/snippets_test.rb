# frozen_string_literal: true

require_relative "test_helper"
require "fileutils"
require "open3"
require "rbconfig"
require "tmpdir"

# Every Ruby block in the docs (sai-platform) runs against the mock server's fake API.
# See ../../conformance/README.md#docs-snippets.
class SnippetsTest < Minitest::Test
  LIB = File.expand_path("../lib", __dir__)
  REQUIRED = ENV["SAI_DOCS_REQUIRED"] == "1"

  def self.snippets
    out, err, status = Open3.capture3("node", File.join(CONFORMANCE, "snippets.mjs"), "--lang", "ruby")
    return [JSON.parse(out.force_encoding(Encoding::UTF_8)), nil] if status.success?

    [[], err]
  end

  SNIPPETS, PROBLEM = snippets

  def self.server
    @server ||= MockServer.new
  end

  def self.workdir
    @workdir ||= Dir.mktmpdir("sai-snippets").tap do |d|
      FileUtils.cp_r(File.join(CONFORMANCE, "fixtures", "."), d)
      Minitest.after_run { FileUtils.rm_rf(d) }
    end
  end

  # The block as a program: requires first, then the context, then the block.
  def self.program(s)
    return s["code"] if s["context"].to_s.empty?

    lines = "#{s['context']}\n#{s['code']}".lines(chomp: true)
    requires = lines.select { |l| l.start_with?("require ") }.uniq
    body = ->(code) { code.lines(chomp: true).reject { |l| l.start_with?("require ") }.join("\n") }
    "#{requires.join("\n")}\n#{body.call(s['context'])}\n#{body.call(s['code'])}\n"
  end

  if SNIPPETS.empty?
    define_method(:test_finds_the_docs) do
      flunk "no docs: set SAI_DOCS_DIR\n#{PROBLEM}" if REQUIRED
      skip "no docs: check out sai-platform next to sai-sdk, or set SAI_DOCS_DIR"
    end
  end

  SNIPPETS.each do |s|
    define_method("test_#{s['file']}:#{s['line']}") do
      server = self.class.server
      server.control("reset")
      dir = self.class.workdir
      path = File.join(dir, "#{s['file'].gsub(/\W/, '_')}_#{s['line']}.rb")
      File.write(path, self.class.program(s))
      env = {
        "SAI_API_KEY" => "sapi_docs",
        "SAI_ORG_KEY" => "sapi_docs_org",
        "SAI_API_URL" => server.url,
        "SAI_ORG_ID" => "org_docs"
      }
      out, status = Open3.capture2e(env, RbConfig.ruby, "-I", LIB, path, chdir: dir)
      assert status.success?, "#{s['file']}:#{s['line']} failed:\n#{out}"
    end
  end
end
